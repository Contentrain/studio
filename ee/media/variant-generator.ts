/**
 * Variant generation from optimized original.
 *
 * Takes an original image buffer + variant configs,
 * produces resized/reformatted variants for each config.
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

import sharp from 'sharp'
import type { VariantConfig, MediaVariant } from '../../server/providers/media'

export interface GeneratedVariant {
  name: string
  buffer: Buffer
  variant: MediaVariant
}

/**
 * Generate all variants from an optimized original image.
 */
export async function generateVariants(
  originalBuffer: Buffer,
  assetId: string,
  variants: Record<string, VariantConfig>,
): Promise<GeneratedVariant[]> {
  const results: GeneratedVariant[] = []

  for (const [name, config] of Object.entries(variants)) {
    const result = await generateSingleVariant(originalBuffer, assetId, name, config)
    results.push(result)
  }

  return results
}

async function generateSingleVariant(
  input: Buffer,
  assetId: string,
  name: string,
  config: VariantConfig,
): Promise<GeneratedVariant> {
  let pipeline = sharp(input)

  // Resize with fit mode
  const resizeOptions: sharp.ResizeOptions = {
    width: config.width,
    fit: config.fit as keyof sharp.FitEnum,
    withoutEnlargement: true,
  }
  if (config.height) {
    resizeOptions.height = config.height
  }
  pipeline = pipeline.resize(resizeOptions)

  // Output format
  const format = config.format === 'auto' || !config.format ? 'webp' : config.format
  const quality = config.quality ?? 80

  switch (format) {
    case 'jpeg':
      pipeline = pipeline.jpeg({ quality, mozjpeg: true })
      break
    case 'png':
      pipeline = pipeline.png({ quality })
      break
    case 'avif':
      pipeline = pipeline.avif({ quality })
      break
    default:
      pipeline = pipeline.webp({ quality })
  }

  const result = await pipeline.toBuffer({ resolveWithObject: true })
  const ext = format === 'jpeg' ? 'jpg' : format

  return {
    name,
    buffer: result.data,
    variant: {
      path: `media/${name}/${assetId}.${ext}`,
      width: result.info.width,
      height: result.info.height,
      format,
      size: result.data.length,
    },
  }
}
