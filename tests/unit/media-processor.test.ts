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

  describe('privacy: nothing identifying survives into the public master', () => {
    // 40x20 as stored: left half red, right half blue, EXIF orientation 6 (display = rotated 90° clockwise → 20x40, red on top).
    async function photo(): Promise<Buffer> {
      const blue = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer()
      return sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 255, g: 0, b: 0 } } })
        .composite([{ input: blue, left: 20, top: 0 }])
        .jpeg({ quality: 95 })
        .withExif({
          IFD0: { Make: 'FakeCam', Model: 'Secret-X1', Copyright: 'Jane Doe' },
          IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '41/1 0/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '29/1 0/1 0/1' },
        })
        .withMetadata({ orientation: 6 }) // sharp writes the orientation tag only through this option
        .toBuffer()
    }

    it('the fixture itself carries the EXIF it is meant to test with', async () => {
      const input = await photo()
      const meta = await sharp(input).metadata()
      expect(meta.exif).toBeDefined()
      expect(meta.orientation).toBe(6)
      expect(input.includes(Buffer.from('FakeCam'))).toBe(true)
    })

    it('drops EXIF/GPS/camera/owner, XMP, IPTC and the profile from the output', async () => {
      const result = await optimizeImage(await photo(), 'image/jpeg')
      const meta = await sharp(result.buffer).metadata()

      expect(meta.exif).toBeUndefined()
      expect(meta.xmp).toBeUndefined()
      expect(meta.iptc).toBeUndefined()
      expect(meta.icc).toBeUndefined()
      expect(meta.orientation).toBeUndefined()
      for (const secret of ['FakeCam', 'Secret-X1', 'Jane Doe', 'GPS'])
        expect(result.buffer.includes(Buffer.from(secret))).toBe(false)
    })

    it('applies the EXIF orientation to the pixels: width/height swapped, top stays red', async () => {
      const result = await optimizeImage(await photo(), 'image/jpeg')
      expect({ w: result.width, h: result.height }).toEqual({ w: 20, h: 40 })

      const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true })
      expect({ w: info.width, h: info.height }).toEqual({ w: 20, h: 40 })
      const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)]
      const top = at(10, 5)
      const bottom = at(10, 35)
      expect(top[0]).toBeGreaterThan(200)
      expect(top[2]).toBeLessThan(60)
      expect(bottom[2]).toBeGreaterThan(200)
      expect(bottom[0]).toBeLessThan(60)
    })

    it('converts a wide-gamut input to sRGB pixels, since the profile itself is not kept', async () => {
      // `withIccProfile('p3')` re-encodes the sRGB colour into Display P3 and tags it: the stored numbers are not the colour.
      const color = { r: 128, g: 200, b: 60 }
      const tagged = await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).withIccProfile('p3').jpeg({ quality: 100 }).toBuffer()
      expect((await sharp(tagged).metadata()).icc).toBeDefined()
      const px = async (buffer: Buffer) => [...(await sharp(buffer).raw().toBuffer()).subarray(0, 3)]
      const off = (pixel: number[]) => Math.max(...pixel.map((v, i) => Math.abs(v - [color.r, color.g, color.b][i]!)))

      const result = await optimizeImage(tagged, 'image/jpeg')
      expect((await sharp(result.buffer).metadata()).icc).toBeUndefined()
      expect(off(await px(result.buffer))).toBeLessThanOrEqual(4)
    })

    it('variants made from the master carry no metadata either', async () => {
      const master = await optimizeImage(await photo(), 'image/jpeg')
      const [variant] = await generateVariants(master.buffer, 'asset-1', { thumb: { width: 10, fit: 'cover', format: 'jpeg' } as never })
      const meta = await sharp(variant!.buffer).metadata()
      expect(meta.exif).toBeUndefined()
      expect(meta.icc).toBeUndefined()
      expect(variant!.buffer.includes(Buffer.from('FakeCam'))).toBe(false)
    })
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
