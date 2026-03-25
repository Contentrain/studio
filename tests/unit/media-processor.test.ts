import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { optimizeImage, extractMetadata } from '../../ee/media/media-optimizer'
import { generateVariants } from '../../ee/media/variant-generator'
import { calculateBlurhash } from '../../ee/media/blurhash-calculator'

// Create a minimal test image buffer (1x1 red pixel PNG)
async function createTestImage(width = 100, height = 100): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  }).png().toBuffer()
}

describe('media-optimizer', () => {
  it('optimizes a PNG to WebP', async () => {
    const input = await createTestImage(200, 200)
    const result = await optimizeImage(input, 'image/png')

    expect(result.format).toBe('webp')
    expect(result.width).toBe(200)
    expect(result.height).toBe(200)
    expect(result.size).toBeGreaterThan(0)
    expect(result.buffer).toBeInstanceOf(Buffer)
  })

  it('downscales images exceeding max dimension', async () => {
    // Create a wide image
    const input = await createTestImage(5000, 3000)
    const result = await optimizeImage(input, 'image/jpeg')

    // Should be capped to 4096 max dimension
    expect(result.width).toBeLessThanOrEqual(4096)
    expect(result.height).toBeLessThanOrEqual(4096)
  })

  it('passes through SVG without processing', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>')
    const result = await optimizeImage(svg, 'image/svg+xml')

    expect(result.format).toBe('svg')
    expect(result.buffer).toEqual(svg)
    expect(result.size).toBe(svg.length)
  })

  it('extracts metadata from image', async () => {
    const input = await createTestImage(300, 200)
    const meta = await extractMetadata(input)

    expect(meta.width).toBe(300)
    expect(meta.height).toBe(200)
    expect(meta.format).toBe('png')
  })
})

describe('variant-generator', () => {
  it('generates variants with correct dimensions', async () => {
    const input = await createTestImage(800, 600)
    const optimized = await optimizeImage(input, 'image/png')

    const variants = await generateVariants(optimized.buffer, 'test-id', {
      thumb: { width: 200, height: 150, fit: 'cover', quality: 75 },
      small: { width: 100, height: 100, fit: 'cover', quality: 70 },
    })

    expect(variants).toHaveLength(2)

    const thumb = variants.find(v => v.name === 'thumb')!
    expect(thumb.variant.width).toBe(200)
    expect(thumb.variant.height).toBe(150)
    expect(thumb.variant.path).toBe('media/thumb/test-id.webp')
    expect(thumb.buffer).toBeInstanceOf(Buffer)

    const small = variants.find(v => v.name === 'small')!
    expect(small.variant.width).toBe(100)
    expect(small.variant.height).toBe(100)
  })

  it('respects format override', async () => {
    const input = await createTestImage(400, 300)
    const optimized = await optimizeImage(input, 'image/png')

    const variants = await generateVariants(optimized.buffer, 'fmt-test', {
      og: { width: 1200, height: 630, fit: 'cover', quality: 90, format: 'jpeg' },
    })

    expect(variants[0]!.variant.format).toBe('jpeg')
    expect(variants[0]!.variant.path).toContain('.jpg')
  })

  it('does not enlarge small images', async () => {
    const input = await createTestImage(50, 50)
    const optimized = await optimizeImage(input, 'image/png')

    const variants = await generateVariants(optimized.buffer, 'small-test', {
      hero: { width: 1920, height: 1080, fit: 'cover' },
    })

    // withoutEnlargement = true, so hero variant should not exceed original
    expect(variants[0]!.variant.width).toBeLessThanOrEqual(50)
  })
})

describe('blurhash-calculator', () => {
  it('generates a valid blurhash string', async () => {
    const input = await createTestImage(200, 200)
    const optimized = await optimizeImage(input, 'image/png')

    const hash = await calculateBlurhash(optimized.buffer)

    expect(hash).toBeTruthy()
    expect(typeof hash).toBe('string')
    expect(hash!.length).toBeGreaterThan(5)
  })

  it('returns null for invalid input', async () => {
    const hash = await calculateBlurhash(Buffer.from('not an image'))
    expect(hash).toBeNull()
  })
})
