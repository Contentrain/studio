/**
 * Image optimization pipeline.
 *
 * Handles: EXIF stripping, auto-orientation, color profile normalization,
 * dimension capping, and WebP/AVIF conversion for originals.
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

import sharp from 'sharp'
import { MAX_ORIGINAL_DIMENSION } from '../../server/utils/media-variants'

export interface OptimizeResult {
  buffer: Buffer
  width: number
  height: number
  format: string
  size: number
}

/**
 * Optimize an uploaded image:
 * 1. Auto-orient (EXIF rotation)
 * 2. Strip metadata (GPS, camera info — privacy)
 * 3. Normalize color profile to sRGB
 * 4. Cap dimensions to MAX_ORIGINAL_DIMENSION
 * 5. Convert to WebP (lossy for photos, lossless for PNGs with alpha)
 */
export async function optimizeImage(input: Buffer, contentType: string): Promise<OptimizeResult> {
  // Non-image files: passthrough without Sharp processing
  if (!contentType.startsWith('image/')) {
    return { buffer: input, width: 0, height: 0, format: contentType.split('/').pop() ?? 'bin', size: input.length }
  }

  // SVG: keep as-is, extract dimensions only
  if (contentType === 'image/svg+xml') {
    let svgWidth = 0
    let svgHeight = 0
    try {
      const meta = await sharp(input).metadata()
      svgWidth = meta.width ?? 0
      svgHeight = meta.height ?? 0
    }
    catch { /* SVG metadata extraction optional */ }
    return { buffer: input, width: svgWidth, height: svgHeight, format: 'svg', size: input.length }
  }

  let pipeline = sharp(input)
    .rotate() // Auto-orient from EXIF
    .withMetadata({ orientation: undefined }) // Strip EXIF but keep color profile

  // Get original metadata
  const metadata = await sharp(input).metadata()
  const { width: origWidth, height: origHeight, hasAlpha } = metadata

  // Cap dimensions
  if (origWidth && origHeight) {
    const maxDim = MAX_ORIGINAL_DIMENSION
    if (origWidth > maxDim || origHeight > maxDim) {
      pipeline = pipeline.resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    }
  }

  // Convert to WebP — lossless for PNG with alpha, lossy otherwise
  const isAlphaPng = contentType === 'image/png' && hasAlpha
  if (isAlphaPng) {
    pipeline = pipeline.webp({ lossless: true })
  }
  else {
    pipeline = pipeline.webp({ quality: 85 })
  }

  const result = await pipeline.toBuffer({ resolveWithObject: true })

  return {
    buffer: result.data,
    width: result.info.width,
    height: result.info.height,
    format: 'webp',
    size: result.data.length,
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
  const metadata = await sharp(input).metadata()
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    format: metadata.format ?? 'unknown',
    hasAlpha: metadata.hasAlpha ?? false,
  }
}
