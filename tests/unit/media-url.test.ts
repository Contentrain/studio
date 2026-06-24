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

  it('recognises relative media-storage paths but not external URLs', async () => {
    const { isStoredMediaPath } = await import('../../server/utils/media-url')
    expect(isStoredMediaPath('media/original/x.webp')).toBe(true)
    expect(isStoredMediaPath('https://images.unsplash.com/x.jpg')).toBe(false)
    expect(isStoredMediaPath('//cdn.example/x.png')).toBe(false)
    expect(isStoredMediaPath('data:image/png;base64,AAAA')).toBe(false)
    expect(isStoredMediaPath('')).toBe(false)
    expect(isStoredMediaPath(null)).toBe(false)
    expect(isStoredMediaPath(42)).toBe(false)
  })

  it('rewrites only media paths to delivery URLs, leaving everything else untouched', async () => {
    const { rewriteMediaUrl } = await import('../../server/utils/media-url')
    expect(rewriteMediaUrl('proj-1', 'media/original/x.webp')).toBe(
      'https://studio.example.com/api/cdn/v1/proj-1/media/original/x.webp',
    )
    expect(rewriteMediaUrl('proj-1', 'https://images.unsplash.com/x.jpg')).toBe('https://images.unsplash.com/x.jpg')
    expect(rewriteMediaUrl('proj-1', null)).toBeNull()
    expect(rewriteMediaUrl('proj-1', 123)).toBe(123)
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
