import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('media URL helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.example.com/' } }))
  })

  it('builds the CDN delivery URL, trimming trailing slashes from the base', async () => {
    const { toDeliveryUrl } = await import('../../server/utils/media-url')
    expect(toDeliveryUrl('proj-1', 'media/abc.webp')).toBe(
      'https://studio.example.com/api/cdn/v1/proj-1/media/abc.webp',
    )
  })

  it('decorates an asset with url + variant urls while keeping raw paths', async () => {
    const { withMediaUrls } = await import('../../server/utils/media-url')
    const asset = {
      id: 'a1',
      projectId: 'proj-1',
      originalPath: 'media/abc.webp',
      variants: {
        thumb: { path: 'media/abc_thumb.webp', width: 100, height: 100, format: 'webp', size: 1 },
      },
    } as never

    const out = withMediaUrls('proj-1', asset)

    expect(out.url).toBe('https://studio.example.com/api/cdn/v1/proj-1/media/abc.webp')
    expect(out.variantUrls.thumb).toBe('https://studio.example.com/api/cdn/v1/proj-1/media/abc_thumb.webp')
    expect(out.originalPath).toBe('media/abc.webp')
  })
})
