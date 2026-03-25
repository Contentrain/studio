/**
 * BlurHash placeholder calculation.
 *
 * Generates a compact placeholder string for images
 * that can be rendered client-side during lazy loading.
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

import sharp from 'sharp'
import { encode } from 'blurhash'

/**
 * Calculate BlurHash from an image buffer.
 * Downscales to a small size first for performance.
 */
export async function calculateBlurhash(input: Buffer): Promise<string | null> {
  try {
    // Downscale to 32px wide for fast encoding
    const { data, info } = await sharp(input)
      .resize(32, 32, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    return encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3)
  }
  catch {
    return null
  }
}
