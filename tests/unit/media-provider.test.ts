import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { optimizeImage } from '../../ee/media/media-optimizer'
import { generateVariants } from '../../ee/media/variant-generator'
import { calculateBlurhash } from '../../ee/media/blurhash-calculator'
import { resolveVariantConfig, VARIANT_PRESETS } from '../../server/utils/media-variants'
import { createHash } from 'node:crypto'

async function createTestImage(width = 200, height = 200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  }).png().toBuffer()
}

describe('full media upload pipeline (unit)', () => {
  it('processes an image through the complete pipeline', async () => {
    const input = await createTestImage(800, 600)

    // 1. Content hash
    const contentHash = createHash('sha256').update(input).digest('hex')
    expect(contentHash).toHaveLength(64)

    // 2. Optimize
    const optimized = await optimizeImage(input, 'image/png')
    expect(optimized.format).toBe('webp')
    expect(optimized.width).toBe(800)
    expect(optimized.height).toBe(600)
    expect(optimized.buffer.length).toBeLessThan(input.length) // WebP compression

    // 3. Blurhash
    const blurhash = await calculateBlurhash(optimized.buffer)
    expect(blurhash).toBeTruthy()
    expect(typeof blurhash).toBe('string')

    // 4. Resolve variants from preset
    const variants = resolveVariantConfig('hero-image')
    expect(Object.keys(variants)).toEqual(['hero', 'card', 'thumb', 'og'])

    // 5. Generate variants
    const generated = await generateVariants(optimized.buffer, 'test-asset', variants)
    expect(generated).toHaveLength(4)

    const hero = generated.find(v => v.name === 'hero')!
    expect(hero.variant.width).toBeLessThanOrEqual(800) // Can't upscale
    expect(hero.variant.path).toBe('media/hero/test-asset.webp')

    const og = generated.find(v => v.name === 'og')!
    expect(og.variant.format).toBe('jpeg')
    expect(og.variant.path).toContain('.jpg')

    // 6. Total size calculation
    const totalSize = optimized.size + generated.reduce((sum, v) => sum + v.variant.size, 0)
    expect(totalSize).toBeGreaterThan(0)
  })

  it('handles large images by capping dimensions', async () => {
    const input = await createTestImage(5000, 3000)
    const optimized = await optimizeImage(input, 'image/jpeg')

    expect(optimized.width).toBeLessThanOrEqual(4096)
    expect(optimized.height).toBeLessThanOrEqual(4096)
  })

  it('handles avatar preset with square crops', async () => {
    const input = await createTestImage(500, 500)
    const optimized = await optimizeImage(input, 'image/png')
    const variants = resolveVariantConfig('avatar')
    const generated = await generateVariants(optimized.buffer, 'avatar-test', variants)

    expect(generated).toHaveLength(3) // large, medium, small
    for (const v of generated) {
      expect(v.variant.width).toBe(v.variant.height) // Square
    }
  })

  it('produces all built-in presets without errors', async () => {
    const input = await createTestImage(2000, 1500)
    const optimized = await optimizeImage(input, 'image/jpeg')

    for (const [presetName, config] of Object.entries(VARIANT_PRESETS)) {
      const generated = await generateVariants(optimized.buffer, `preset-${presetName}`, config)
      expect(generated.length).toBeGreaterThan(0)
      for (const v of generated) {
        expect(v.buffer.length).toBeGreaterThan(0)
        expect(v.variant.width).toBeGreaterThan(0)
      }
    }
  })

  it('skips variant generation for non-image files', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake content')
    const optimized = await optimizeImage(pdf, 'application/pdf')

    // Non-image: passthrough
    expect(optimized.format).toBe('pdf')
    expect(optimized.width).toBe(0)
    expect(optimized.buffer).toEqual(pdf)

    // Blurhash returns null
    const hash = await calculateBlurhash(pdf)
    expect(hash).toBeNull()
  })
})
