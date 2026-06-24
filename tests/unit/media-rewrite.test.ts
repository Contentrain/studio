import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDefinition } from '@contentrain/types'
import {
  extractMediaStoragePath,
  normalizeModelContentMedia,
  rewriteEntryMedia,
  rewriteMarkdownMedia,
} from '../../server/utils/media-rewrite'

const BASE = 'https://cdn.test/api/cdn/v1/proj'

describe('media-rewrite', () => {
  beforeEach(() => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://cdn.test' } }))
  })

  describe('extractMediaStoragePath', () => {
    it('returns the path for a bare media path', () => {
      expect(extractMediaStoragePath('media/original/x.webp')).toBe('media/original/x.webp')
    })
    it('extracts the path from an absolute delivery URL', () => {
      expect(extractMediaStoragePath(`${BASE}/media/original/x.webp`)).toBe('media/original/x.webp')
    })
    it('returns null for external URLs and non-media values', () => {
      expect(extractMediaStoragePath('https://images.unsplash.com/y.jpg')).toBeNull()
      expect(extractMediaStoragePath('hello')).toBeNull()
      expect(extractMediaStoragePath(null)).toBeNull()
      expect(extractMediaStoragePath(42)).toBeNull()
    })
  })

  describe('rewriteEntryMedia', () => {
    const fields = {
      title: { type: 'string' as const },
      cover: { type: 'image' as const },
      gallery: { type: 'array' as const, items: 'image' },
      seo: { type: 'object' as const, fields: { og: { type: 'image' as const } } },
    }

    it('rewrites media fields (incl. nested array/object), leaves others', () => {
      const out = rewriteEntryMedia({
        title: 'media/not-a-field-value-but-string',
        cover: 'media/original/a.webp',
        gallery: ['media/original/b.webp', 'https://ext.example/c.jpg'],
        seo: { og: 'media/original/d.webp' },
      }, fields, 'proj')

      // string (non-media) field untouched even if it looks path-like
      expect(out.title).toBe('media/not-a-field-value-but-string')
      expect(out.cover).toBe(`${BASE}/media/original/a.webp`)
      expect((out.gallery as string[])[0]).toBe(`${BASE}/media/original/b.webp`)
      expect((out.gallery as string[])[1]).toBe('https://ext.example/c.jpg')
      expect((out.seo as Record<string, unknown>).og).toBe(`${BASE}/media/original/d.webp`)
    })

    it('does not mutate the input object', () => {
      const input = { cover: 'media/original/a.webp' }
      const out = rewriteEntryMedia(input, { cover: { type: 'image' } }, 'proj')
      expect(input.cover).toBe('media/original/a.webp')
      expect(out.cover).toBe(`${BASE}/media/original/a.webp`)
    })
  })

  describe('rewriteMarkdownMedia', () => {
    it('rewrites markdown image/link targets and inline html, skips external', () => {
      const body = 'A ![alt](media/original/a.webp) and [d](media/original/b.pdf) and <img src="media/original/c.png"> and ![x](https://ext.example/y.jpg).'
      const out = rewriteMarkdownMedia(body, 'proj')
      expect(out).toContain(`](${BASE}/media/original/a.webp)`)
      expect(out).toContain(`](${BASE}/media/original/b.pdf)`)
      expect(out).toContain(`src="${BASE}/media/original/c.png"`)
      expect(out).toContain('](https://ext.example/y.jpg)')
    })
  })

  describe('normalizeModelContentMedia', () => {
    it('rewrites every entry in a collection', () => {
      const model = {
        id: 'posts', kind: 'collection', fields: { cover: { type: 'image' } },
      } as unknown as ModelDefinition
      const out = normalizeModelContentMedia(model, {
        a: { cover: 'media/original/a.webp' },
        b: { cover: 'https://ext.example/b.jpg' },
      }, 'proj') as Record<string, { cover: string }>
      expect(out.a.cover).toBe(`${BASE}/media/original/a.webp`)
      expect(out.b.cover).toBe('https://ext.example/b.jpg')
    })

    it('rewrites a singleton object', () => {
      const model = { id: 'hero', kind: 'singleton', fields: { bg: { type: 'image' } } } as unknown as ModelDefinition
      const out = normalizeModelContentMedia(model, { bg: 'media/original/h.webp' }, 'proj') as { bg: string }
      expect(out.bg).toBe(`${BASE}/media/original/h.webp`)
    })

    it('leaves dictionaries and field-less models untouched', () => {
      const dict = { id: 'ui', kind: 'dictionary', fields: { k: { type: 'string' } } } as unknown as ModelDefinition
      const content = { k: 'media/original/should-not-touch.webp' }
      expect(normalizeModelContentMedia(dict, content, 'proj')).toEqual(content)

      const noFields = { id: 'x', kind: 'collection' } as unknown as ModelDefinition
      const c2 = { a: { cover: 'media/original/a.webp' } }
      expect(normalizeModelContentMedia(noFields, c2, 'proj')).toEqual(c2)
    })
  })
})
