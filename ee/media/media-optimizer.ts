/**
 * Image optimization pipeline.
 *
 * Handles: EXIF stripping, auto-orientation, color profile normalization,
 * dimension capping, and WebP/AVIF conversion for originals.
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

import { loadSharp } from './lazy-sharp'
import { ANIMATION_LIMITS, MAX_ORIGINAL_DIMENSION } from '../../server/utils/media-variants'
import { assertAnimationWithinLimits, canAnimate, frameCount, rethrowAnimationFailure } from './animation'

const PIXEL_LIMIT = 100_000_000 // 100 megapixels — prevents decompression bombs

export interface OptimizeResult {
  buffer: Buffer
  width: number
  height: number
  format: string
  size: number
  /** More than one frame: the master is an animated WebP. `height` is one frame's. */
  animated?: boolean
}

/**
 * Optimize an uploaded image:
 * 1. Auto-orient (EXIF rotation)
 * 2. Strip all metadata (EXIF/GPS/camera, XMP, IPTC — privacy); nothing is carried over from the input
 * 3. Convert to sRGB pixels (no profile embedded)
 * 4. Cap dimensions to MAX_ORIGINAL_DIMENSION
 * 5. Convert to WebP (lossy for photos, lossless for PNGs with alpha)
 *
 * An animated GIF/WebP stays animated (all frames, delays and loop), within `ANIMATION_LIMITS`; over a limit it is
 * rejected with a localised 400 — never reduced to its first frame.
 */
export async function optimizeImage(input: Buffer, contentType: string): Promise<OptimizeResult> {
  // Non-image files: passthrough without Sharp processing
  if (!contentType.startsWith('image/')) {
    return { buffer: input, width: 0, height: 0, format: contentType.split('/').pop() ?? 'bin', size: input.length }
  }

  const sharp = await loadSharp()

  // SVG: keep as-is, extract dimensions only
  if (contentType === 'image/svg+xml') {
    let svgWidth = 0
    let svgHeight = 0
    try {
      const meta = await sharp(input, { limitInputPixels: PIXEL_LIMIT }).metadata()
      svgWidth = meta.width ?? 0
      svgHeight = meta.height ?? 0
    }
    catch { /* SVG metadata extraction optional */ }
    return { buffer: input, width: svgWidth, height: svgHeight, format: 'svg', size: input.length }
  }

  // Probe first (sharp's default read: one frame's width/height, `pages` = frame count).
  const metadata = await sharp(input, { limitInputPixels: PIXEL_LIMIT }).metadata()
  const { width: origWidth, height: origHeight, hasAlpha } = metadata
  const frames = frameCount(metadata.pages)
  const animated = canAnimate(contentType) && frames > 1
  if (animated) assertAnimationWithinLimits({ frames, width: origWidth ?? 0, height: origHeight ?? 0 })

  // No `withMetadata()`/`keepMetadata()` here: sharp then writes none of the input's EXIF/XMP/IPTC (GPS, camera, owner)
  // and no embedded profile. `.rotate()` applies the EXIF orientation to the pixels first; the sRGB conversion is explicit
  // so the pixels stay right once the input's own profile is gone.
  let pipeline = sharp(input, { limitInputPixels: PIXEL_LIMIT, ...(animated ? { animated: true } : {}) })
    .rotate()
    .toColourspace('srgb')
  if (animated) pipeline = pipeline.timeout({ seconds: ANIMATION_LIMITS.timeoutSeconds })

  // Cap dimensions
  if (origWidth && origHeight) {
    const maxDim = MAX_ORIGINAL_DIMENSION
    if (origWidth > maxDim || origHeight > maxDim) {
      pipeline = pipeline.resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    }
  }

  // Convert to WebP — lossless for PNG with alpha, lossy otherwise (an animation keeps every frame)
  const isAlphaPng = contentType === 'image/png' && hasAlpha
  if (isAlphaPng) {
    pipeline = pipeline.webp({ lossless: true })
  }
  else {
    pipeline = pipeline.webp({ quality: 85 })
  }

  const result = await pipeline.toBuffer({ resolveWithObject: true }).catch(error => animated ? rethrowAnimationFailure(error) : Promise.reject(error))

  return {
    buffer: result.data,
    width: result.info.width,
    // An animated result is every frame stacked: the frame's own height is `pageHeight`.
    height: result.info.pageHeight ?? result.info.height,
    format: 'webp',
    size: result.data.length,
    ...(animated ? { animated: true } : {}),
  }
}

/**
 * Extract metadata from an image without processing it.
 */
export async function extractMetadata(input: Buffer): Promise<{
  width: number
  height: number
  format: string
  hasAlpha: boolean
}> {
  const sharp = await loadSharp()
  const metadata = await sharp(input, { limitInputPixels: PIXEL_LIMIT }).metadata()
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    format: metadata.format ?? 'unknown',
    hasAlpha: metadata.hasAlpha ?? false,
  }
}
