import { describe, expect, it } from 'vitest'
import { validateContent } from '../../server/utils/content-validation'

describe('content validation', () => {
  it('enforces required and unique collection fields', () => {
    const result = validateContent(
      {
        title: '',
        slug: 'hello-world',
      },
      {
        title: { type: 'string', required: true, unique: true },
        slug: { type: 'slug', required: true, unique: true },
      },
      'blog-post',
      'en',
      'entry-2',
      {
        currentEntryId: 'entry-2',
        allEntries: {
          'entry-1': {
            title: 'Hello World',
            slug: 'hello-world',
          },
          'entry-2': {},
        },
      },
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'title', message: 'title is required', severity: 'error' }),
        expect.objectContaining({
          field: 'slug',
          message: 'slug must be unique — "hello-world" already exists in entry entry-1',
          severity: 'error',
        }),
      ]),
    )
  })

  it('validates arrays, nested object items, and select options', () => {
    const result = validateContent(
      {
        tags: ['launch', 3],
        seo: [
          { title: 'Ok' },
          { title: '' },
        ],
        status: 'archived',
      },
      {
        tags: { type: 'array', items: 'string', min: 1, max: 3 },
        seo: {
          type: 'array',
          items: {
            type: 'object',
            fields: {
              title: { type: 'string', required: true, min: 2 },
            },
          },
        },
        status: { type: 'select', options: ['draft', 'published'] },
      },
      'landing-page',
      'en',
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'tags[1]', message: 'tags[1] must be a string' }),
        expect.objectContaining({ field: 'seo[1].title', message: 'title is required' }),
        expect.objectContaining({ field: 'status', message: 'status must be one of: draft, published' }),
      ]),
    )
  })

  it('warns on invalid regex definitions and weak email/url values', () => {
    const result = validateContent(
      {
        email: 'not-an-email',
        website: 'ftp://example.com',
        code: 'ABC-123',
      },
      {
        email: { type: 'email' },
        website: { type: 'url' },
        code: { type: 'code', pattern: '[' },
      },
      'settings',
      'en',
    )

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'email', severity: 'warning', message: 'email may not be a valid email' }),
        expect.objectContaining({ field: 'website', severity: 'warning', message: 'website may not be a valid URL' }),
        expect.objectContaining({ field: 'code', severity: 'warning', message: 'code has invalid regex pattern: [' }),
      ]),
    )
  })

  it('rejects invalid polymorphic and scalar relation values', () => {
    const result = validateContent(
      {
        author: 42,
        related: { model: 'faq', ref: 'entry-1' },
      },
      {
        author: { type: 'relation', model: 'authors' },
        related: { type: 'relation', model: ['posts', 'products'] },
      },
      'blog-post',
      'en',
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'author', message: 'author must be a string (entry ID or slug)' }),
        expect.objectContaining({ field: 'related', message: 'related target model "faq" must be one of: posts, products' }),
      ]),
    )
  })
})
