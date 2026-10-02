import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { optimizeImage } from '../../ee/media/media-optimizer'
import { generateVariants } from '../../ee/media/variant-generator'
import { calculateBlurhash } from '../../ee/media/blurhash-calculator'
import { assertAnimationWithinLimits, rethrowAnimationFailure } from '../../ee/media/animation'
import { ANIMATION_LIMITS } from '../../server/utils/media-variants'

/** An animation of `frames` solid frames, each a different red/blue mix, with a 100 ms delay and an endless loop. */
async function animation(format: 'gif' | 'webp', { frames = 4, width = 60, height = 40 } = {}): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3 * frames)
  for (let f = 0; f < frames; f++) {
    for (let p = 0; p < width * height; p++) {
      const at = (f * width * height + p) * 3
      raw[at] = (f * 60) % 256
      raw[at + 2] = 255 - ((f * 60) % 256)
    }
  }
  return sharp(raw, { raw: { width, height: height * frames, channels: 3, pageHeight: height } })[format]({ loop: 0, delay: Array.from({ length: frames }, () => 100) }).toBuffer()
}

const read = (buffer: Buffer) => sharp(buffer, { animated: true }).metadata()

describe('animated GIF/WebP uploads', () => {
  it.each(['gif', 'webp'] as const)('an animated %s stays an animation: every frame, its delays and loop, one frame\'s height', async (format) => {
    const input = await animation(format)
    expect((await read(input)).pages).toBe(4)

    const result = await optimizeImage(input, `image/${format}`)
    const meta = await read(result.buffer)

    expect(result.format).toBe('webp')
    expect(result.animated).toBe(true)
    expect(meta.pages).toBe(4)
    expect(meta.delay).toEqual([100, 100, 100, 100])
    expect(meta.loop).toBe(0)
    expect({ w: result.width, h: result.height }).toEqual({ w: 60, h: 40 })
    expect(meta.pageHeight).toBe(40)
  })

  it('a single-frame GIF is a still, as before', async () => {
    const result = await optimizeImage(await animation('gif', { frames: 1 }), 'image/gif')
    expect(result.animated).toBeUndefined()
    expect((await read(result.buffer)).pages ?? 1).toBe(1)
    expect({ w: result.width, h: result.height }).toEqual({ w: 60, h: 40 })
  })

  it('an animation wider than the 4096 px cap is scaled down with all its frames', async () => {
    const result = await optimizeImage(await animation('webp', { frames: 3, width: 4500, height: 60 }), 'image/webp')
    const meta = await read(result.buffer)
    expect(meta.pages).toBe(3)
    expect(result.width).toBe(4096)
    expect(meta.pageHeight).toBe(result.height)
    expect(result.height).toBeLessThan(60)
  })

  it('carries no metadata, like every other master', async () => {
    const meta = await read((await optimizeImage(await animation('gif'), 'image/gif')).buffer)
    expect(meta.exif).toBeUndefined()
    expect(meta.xmp).toBeUndefined()
    expect(meta.icc).toBeUndefined()
  })

  it('over the frame limit it is rejected with a 400 and a message that names the limit — never cut to one frame', async () => {
    const frames = ANIMATION_LIMITS.maxFrames + 1
    const input = await animation('gif', { frames, width: 8, height: 8 })
    await expect(optimizeImage(input, 'image/gif')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(`${frames} frames`),
    })
    await expect(optimizeImage(input, 'image/gif')).rejects.toMatchObject({ message: expect.stringContaining(String(ANIMATION_LIMITS.maxFrames)) })
  })

  it('over the total pixel limit (frames × width × height) it is rejected with a 400 and the sizes', () => {
    // 64 MP over all frames. Checked on the header's numbers: decoding that much for real would take ~260 MB.
    const width = 2000
    const height = 1000
    const frames = Math.floor(ANIMATION_LIMITS.maxTotalPixels / (width * height)) + 1
    expect(() => assertAnimationWithinLimits({ frames, width, height })).toThrowError(expect.objectContaining({
      statusCode: 400,
      message: expect.stringMatching(/66 megapixels across all its frames; the limit is 64/),
    }))
    expect(() => assertAnimationWithinLimits({ frames: frames - 1, width, height })).not.toThrow()
  })

  it('a pipeline that is stopped by its time budget says so in a 400, other errors pass through', () => {
    expect(() => rethrowAnimationFailure(new Error('timeout: process was terminated'))).toThrowError(expect.objectContaining({
      statusCode: 400,
      message: expect.stringContaining(`${ANIMATION_LIMITS.timeoutSeconds} seconds`),
    }))
    const other = new Error('Input buffer contains unsupported image format')
    expect(() => rethrowAnimationFailure(other)).toThrow(other)
  })
})

describe('variants of an animated master', () => {
  it('a WebP variant keeps the animation (frames, delays) at its own size', async () => {
    const master = await optimizeImage(await animation('gif'), 'image/gif')
    const [thumb] = await generateVariants(master.buffer, 'a1', { thumb: { width: 30, height: 20, fit: 'cover' } })
    const meta = await read(thumb!.buffer)
    expect(meta.pages).toBe(4)
    expect(meta.delay).toEqual([100, 100, 100, 100])
    expect({ w: thumb!.variant.width, h: thumb!.variant.height }).toEqual({ w: 30, h: 20 })
    expect(meta.pageHeight).toBe(20)
  })

  it('a variant asked for as JPEG/PNG is a still by its format: the first frame at the requested size, not the frames stacked', async () => {
    const master = await optimizeImage(await animation('gif'), 'image/gif')
    const [og, icon] = await generateVariants(master.buffer, 'a1', {
      og: { width: 30, height: 20, fit: 'cover', format: 'jpeg' },
      icon: { width: 16, height: 16, fit: 'contain', format: 'png' },
    })
    for (const [made, w, h] of [[og!, 30, 20], [icon!, 16, 16]] as const) {
      const meta = await sharp(made.buffer).metadata()
      expect({ w: made.variant.width, h: made.variant.height }).toEqual({ w, h })
      expect({ w: meta.width, h: meta.height }).toEqual({ w, h })
      expect(meta.pages ?? 1).toBe(1)
    }
  })

  it('a still master still gives still variants', async () => {
    const still = await sharp({ create: { width: 100, height: 60, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()
    const master = await optimizeImage(still, 'image/png')
    const [card] = await generateVariants(master.buffer, 'a2', { card: { width: 50, fit: 'inside' } })
    expect((await read(card!.buffer)).pages ?? 1).toBe(1)
    expect(card!.variant.height).toBe(30)
  })

  it('blurhash still comes from the first frame of an animated master', async () => {
    const master = await optimizeImage(await animation('webp'), 'image/webp')
    expect(await calculateBlurhash(master.buffer)).toEqual(expect.any(String))
  })
})
