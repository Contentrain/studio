import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createGit(overrides: Partial<{
  getTree: () => Promise<Array<{ path: string, sha: string, type: 'blob' | 'tree' }>>
  readFile: (path: string) => Promise<string>
  listDirectory: (path: string) => Promise<string[]>
}> = {}) {
  return {
    getTree: vi.fn(overrides.getTree ?? (async () => [
      { path: '.contentrain/config.json', sha: 'sha-config', type: 'blob' },
      { path: '.contentrain/models/posts.json', sha: 'sha-model', type: 'blob' },
      { path: '.contentrain/content/marketing/posts/en.json', sha: 'sha-content', type: 'blob' },
      { path: '.contentrain/meta/marketing/posts/en.json', sha: 'sha-meta', type: 'blob' },
    ])),
    readFile: vi.fn(overrides.readFile ?? (async (path: string) => {
      if (path === '.contentrain/config.json') {
        return JSON.stringify({
          stack: 'nuxt',
          domains: ['marketing'],
          workflow: 'review',
          locales: { default: 'en', supported: ['en'] },
        })
      }
      if (path === '.contentrain/models/posts.json') {
        return JSON.stringify({
          id: 'posts',
          name: 'Posts',
          kind: 'collection',
          domain: 'marketing',
          i18n: true,
          fields: {
            title: { type: 'string' },
          },
        })
      }
      if (path === '.contentrain/content/marketing/posts/en.json') {
        return JSON.stringify({
          entry1: { title: 'Hello' },
          entry2: { title: 'World' },
        })
      }
      if (path === '.contentrain/meta/marketing/posts/en.json') {
        return JSON.stringify({
          entry1: { status: 'published' },
          entry2: { status: 'draft' },
        })
      }
      if (path === '.contentrain/vocabulary.json') {
        return JSON.stringify({
          terms: {
            headline: { en: 'Headline' },
          },
        })
      }
      if (path === '.contentrain/context.json') {
        return JSON.stringify({
          stats: { models: 1, entries: 2, locales: ['en'] },
        })
      }
      throw new Error(`Unexpected read: ${path}`)
    })),
    listDirectory: vi.fn(overrides.listDirectory ?? (async (path: string) => {
      if (path === '.contentrain/models') return ['posts.json']
      return []
    })),
  }
}

describe('brain cache', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-27T00:00:00.000Z'))
    vi.stubGlobal('resolveConfigPath', vi.fn().mockReturnValue('.contentrain/config.json'))
    vi.stubGlobal('resolveModelsDir', vi.fn().mockReturnValue('.contentrain/models'))
    vi.stubGlobal('resolveContentPath', vi.fn().mockReturnValue('.contentrain/content/marketing/posts/en.json'))
    vi.stubGlobal('resolveMetaPath', vi.fn().mockReturnValue('.contentrain/meta/marketing/posts/en.json'))
    vi.stubGlobal('resolveVocabularyPath', vi.fn().mockReturnValue('.contentrain/vocabulary.json'))
    vi.stubGlobal('resolveContextPath', vi.fn().mockReturnValue('.contentrain/context.json'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('builds and reuses a project cache entry while the tree hash is unchanged', async () => {
    const git = createGit()
    const mod = await import('../../server/utils/brain-cache')

    const first = await mod.getOrBuildBrainCache(git as never, '', 'project-1')
    const second = await mod.getOrBuildBrainCache(git as never, '', 'project-1')

    expect(first.models.size).toBe(1)
    expect(first.contentSummary.posts).toEqual({
      count: 2,
      locales: ['en'],
      kind: 'collection',
    })
    expect(second).toBe(first)
    expect(mod.getBrainCache('project-1')).toBe(first)
    expect(mod.isBrainStale('project-1')).toBe(false)
  })

  it('rebuilds after invalidation and produces a compact content index', async () => {
    const git = createGit()
    const mod = await import('../../server/utils/brain-cache')

    const brain = await mod.buildBrainSnapshot(git as never, '', 'project-2')
    const index = mod.buildContentIndex(brain)

    expect(index).toContain('Posts (posts): collection, 2 entries')
    expect(index).toContain('published: 1, draft: 1')

    await mod.getOrBuildBrainCache(git as never, '', 'project-2')
    mod.invalidateBrainCache('project-2')
    expect(mod.getBrainCache('project-2')).toBeNull()
  })

  it('keeps document date fields as strings instead of gray-matter Date objects', async () => {
    // Regression: gray-matter (js-yaml DEFAULT_SCHEMA) coerces an unquoted
    // `published_at: 2026-03-12` into a JS Date, which the field validator
    // rejects as "expected date, got object" — an error no re-save can
    // clear. The brain must normalize it back to a YYYY-MM-DD string.
    const git = {
      getTree: vi.fn(async () => [
        { path: '.contentrain/config.json', sha: 'c', type: 'blob' as const },
        { path: '.contentrain/models/blog.json', sha: 'm', type: 'blob' as const },
        { path: '.contentrain/content/marketing/blog/designing-calm-interfaces.md', sha: 'd', type: 'blob' as const },
      ]),
      readFile: vi.fn(async (path: string) => {
        if (path === '.contentrain/config.json') {
          return JSON.stringify({ stack: 'nuxt', domains: ['marketing'], workflow: 'auto-merge', locales: { default: 'en', supported: ['en'] } })
        }
        if (path === '.contentrain/models/blog.json') {
          return JSON.stringify({ id: 'blog', name: 'Blog', kind: 'document', domain: 'marketing', i18n: false, fields: { title: { type: 'string' }, published_at: { type: 'date' } } })
        }
        if (path === '.contentrain/content/marketing/blog/designing-calm-interfaces.md') {
          return '---\ntitle: Designing Calm Interfaces\npublished_at: 2026-03-12\n---\n\nBody text.\n'
        }
        throw new Error(`Unexpected read: ${path}`)
      }),
      listDirectory: vi.fn(async (path: string) => {
        if (path === '.contentrain/models') return ['blog.json']
        if (path === '.contentrain/content/marketing/blog') return ['designing-calm-interfaces.md']
        return []
      }),
    }

    const mod = await import('../../server/utils/brain-cache')
    const brain = await mod.buildBrainSnapshot(git as never, '', 'project-doc')

    const docs = brain.content.get('blog:en') as Array<{ slug: string, frontmatter: Record<string, unknown> }>
    expect(Array.isArray(docs)).toBe(true)
    expect(docs[0]!.frontmatter.published_at).toBe('2026-03-12')
    expect(typeof docs[0]!.frontmatter.published_at).toBe('string')

    // And schema validation must not flag a date type mismatch.
    const dateErrors = (brain.schemaValidation?.warnings ?? []).filter(w => w.message.includes('expected date'))
    expect(dateErrors).toEqual([])
  })
})
