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

  it('keeps the tree fingerprint short however many files the project has', async () => {
    // It used to BE the manifest — every tracked path and blob SHA joined by
    // `|`. The client stores that and sends it back as `?treeSha=`, so on a
    // real project the URL reached ~30KB and every sync after the first was
    // answered with HTTP 431. A fingerprint has to survive leaving the process.
    const git = createGit({
      getTree: async () => Array.from({ length: 250 }, (_, i) => ({
        path: `.contentrain/content/blog/guide-sections/section-${i}/en.md`,
        sha: `${i}`.padStart(40, 'a'),
        type: 'blob' as const,
      })),
      listDirectory: async () => [],
    })
    const mod = await import('../../server/utils/brain-cache')

    const entry = await mod.getOrBuildBrainCache(git as never, '', 'project-long')

    expect(entry.treeSha).toMatch(/^[0-9a-f]{64}$/)
    // The per-path map is what the incremental refresh reads; the fingerprint
    // never needed to carry the parts.
    expect(entry.fileShas.size).toBe(250)
  })

  it('still notices a change to any tracked file', async () => {
    // Hashing must not cost sensitivity: one differing blob SHA anywhere has to
    // produce a different fingerprint, or a delta sync would report "no
    // changes" over stale content.
    const mod = await import('../../server/utils/brain-cache')

    const before = await mod.getOrBuildBrainCache(createGit() as never, '', 'project-sensitive')
    mod.dropBrainCache('project-sensitive')

    const after = await mod.getOrBuildBrainCache(createGit({
      getTree: async () => [
        { path: '.contentrain/config.json', sha: 'sha-config', type: 'blob' },
        { path: '.contentrain/models/posts.json', sha: 'sha-model', type: 'blob' },
        { path: '.contentrain/content/marketing/posts/en.json', sha: 'sha-content-CHANGED', type: 'blob' },
        { path: '.contentrain/meta/marketing/posts/en.json', sha: 'sha-meta', type: 'blob' },
      ],
    }) as never, '', 'project-sensitive')

    expect(after.treeSha).not.toBe(before.treeSha)
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

  it('produces a compact content index', async () => {
    const git = createGit()
    const mod = await import('../../server/utils/brain-cache')

    const brain = await mod.buildBrainSnapshot(git as never, '', 'project-2')
    const index = mod.buildContentIndex(brain)

    expect(index).toContain('Posts (posts): collection, 2 entries')
    expect(index).toContain('published: 1, draft: 1')
  })

  it('marks the entry stale on invalidation and refreshes it incrementally', async () => {
    // v1 tree, then a write bumps only the content blob's SHA.
    let phase: 1 | 2 = 1
    const contentV2 = JSON.stringify({
      entry1: { title: 'Hello' },
      entry2: { title: 'World' },
      entry3: { title: 'Again' },
    })
    const git = createGit({
      getTree: async () => [
        { path: '.contentrain/config.json', sha: 'sha-config', type: 'blob' },
        { path: '.contentrain/models/posts.json', sha: 'sha-model', type: 'blob' },
        { path: '.contentrain/content/marketing/posts/en.json', sha: phase === 1 ? 'sha-content' : 'sha-content-v2', type: 'blob' },
        { path: '.contentrain/meta/marketing/posts/en.json', sha: 'sha-meta', type: 'blob' },
      ],
    })
    const baseRead = git.readFile.getMockImplementation()!
    git.readFile.mockImplementation(async (path: string) =>
      (phase === 2 && path === '.contentrain/content/marketing/posts/en.json') ? contentV2 : baseRead(path),
    )

    const mod = await import('../../server/utils/brain-cache')
    const first = await mod.getOrBuildBrainCache(git as never, '', 'project-2')
    expect(first.contentSummary.posts?.count).toBe(2)

    mod.invalidateBrainCache('project-2')
    // The entry is retained (stale), not dropped.
    expect(mod.getBrainCache('project-2')).not.toBeNull()
    expect(mod.isBrainStale('project-2')).toBe(true)

    phase = 2
    git.readFile.mockClear()
    const second = await mod.getOrBuildBrainCache(git as never, '', 'project-2')

    // Incremental: only the affected model was re-read — no config, no
    // model definitions, no vocabulary/context.
    const readPaths = git.readFile.mock.calls.map(c => c[0])
    expect(readPaths).toContain('.contentrain/content/marketing/posts/en.json')
    expect(readPaths).not.toContain('.contentrain/config.json')
    expect(readPaths).not.toContain('.contentrain/models/posts.json')
    expect(readPaths).not.toContain('.contentrain/vocabulary.json')

    expect(second).not.toBe(first)
    expect(second.stale).toBe(false)
    expect(second.contentSummary.posts?.count).toBe(3)
    expect(mod.isBrainStale('project-2')).toBe(false)
    // The old snapshot object is untouched (concurrent readers).
    expect(first.contentSummary.posts?.count).toBe(2)
  })

  it('incremental refresh output matches a full rebuild (parity)', async () => {
    let phase: 1 | 2 = 1
    const contentV2 = JSON.stringify({ entry1: { title: 'Hello v2' } })
    const git = createGit({
      getTree: async () => [
        { path: '.contentrain/config.json', sha: 'sha-config', type: 'blob' },
        { path: '.contentrain/models/posts.json', sha: 'sha-model', type: 'blob' },
        { path: '.contentrain/content/marketing/posts/en.json', sha: phase === 1 ? 'sha-content' : 'sha-content-v2', type: 'blob' },
        { path: '.contentrain/meta/marketing/posts/en.json', sha: 'sha-meta', type: 'blob' },
      ],
    })
    const baseRead = git.readFile.getMockImplementation()!
    git.readFile.mockImplementation(async (path: string) =>
      (phase === 2 && path === '.contentrain/content/marketing/posts/en.json') ? contentV2 : baseRead(path),
    )

    const mod = await import('../../server/utils/brain-cache')
    const v1 = await mod.buildBrainSnapshot(git as never, '', 'project-parity')

    phase = 2
    const refreshed = await mod.refreshBrainSnapshot(git as never, '', 'project-parity', v1)
    const full = await mod.buildBrainSnapshot(git as never, '', 'project-parity', v1)

    expect(refreshed).not.toBeNull()
    // Fake timers freeze lastRefresh, so the entries compare fully.
    expect(refreshed).toEqual(full)
  })

  it('falls back to a full rebuild when a model definition changes (structural)', async () => {
    const git = createGit()
    const mod = await import('../../server/utils/brain-cache')
    const v1 = await mod.buildBrainSnapshot(git as never, '', 'project-structural')

    const structuralTree = [
      { path: '.contentrain/config.json', sha: 'sha-config', type: 'blob' as const },
      { path: '.contentrain/models/posts.json', sha: 'sha-model-CHANGED', type: 'blob' as const },
      { path: '.contentrain/content/marketing/posts/en.json', sha: 'sha-content', type: 'blob' as const },
      { path: '.contentrain/meta/marketing/posts/en.json', sha: 'sha-meta', type: 'blob' as const },
    ]
    const refreshed = await mod.refreshBrainSnapshot(git as never, '', 'project-structural', v1, structuralTree)
    expect(refreshed).toBeNull()
  })

  it('dedupes concurrent stale refreshes into one build', async () => {
    const git = createGit()
    const mod = await import('../../server/utils/brain-cache')

    await mod.getOrBuildBrainCache(git as never, '', 'project-dedup')
    mod.invalidateBrainCache('project-dedup')

    git.getTree.mockClear()
    const [a, b] = await Promise.all([
      mod.getOrBuildBrainCache(git as never, '', 'project-dedup'),
      mod.getOrBuildBrainCache(git as never, '', 'project-dedup'),
    ])

    expect(a).toBe(b)
    expect(git.getTree).toHaveBeenCalledTimes(1)
  })

  it('full-rebuilds off the default branch when contentrain is missing on a stale refresh', async () => {
    // When the contentrain branch is transiently gone (e.g. deleted by a
    // merge), a stale-cache refresh must not serve the old cached entry —
    // it must fall back to a full rebuild that reads the default branch.
    let phase: 1 | 2 = 1
    const treeFor = (contentSha: string) => [
      { path: '.contentrain/config.json', sha: 'sha-config', type: 'blob' as const },
      { path: '.contentrain/models/posts.json', sha: 'sha-model', type: 'blob' as const },
      { path: '.contentrain/content/marketing/posts/en.json', sha: contentSha, type: 'blob' as const },
      { path: '.contentrain/meta/marketing/posts/en.json', sha: 'sha-meta', type: 'blob' as const },
    ]
    const contentV2 = JSON.stringify({ e1: { title: 'A' }, e2: { title: 'B' }, e3: { title: 'C' } })

    const git = createGit({
      // contentrain 404s in phase 2; the no-ref (default branch) fetch
      // still resolves — with the post-merge content.
      getTree: (async (ref?: string) => {
        if (ref === 'contentrain') {
          if (phase === 2) throw new Error('404: contentrain missing')
          return treeFor('sha-content')
        }
        return phase === 2 ? treeFor('sha-content-v2') : treeFor('sha-content')
      }) as never,
    })
    const baseRead = git.readFile.getMockImplementation()!
    git.readFile.mockImplementation(async (path: string) =>
      (phase === 2 && path === '.contentrain/content/marketing/posts/en.json') ? contentV2 : baseRead(path),
    )

    const mod = await import('../../server/utils/brain-cache')
    const first = await mod.getOrBuildBrainCache(git as never, '', 'project-missing-ref')
    expect(first.contentSummary.posts?.count).toBe(2)

    mod.invalidateBrainCache('project-missing-ref')
    phase = 2
    const second = await mod.getOrBuildBrainCache(git as never, '', 'project-missing-ref')

    // Rebuilt off the default branch — NOT the stale count of 2.
    expect(second.stale).toBe(false)
    expect(second.contentSummary.posts?.count).toBe(3)
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

  it('exposes document status as a slug-keyed meta map (per-slug meta → bundle.meta)', async () => {
    // Regression: document meta lives per-slug. The brain used to nest it inside
    // each entry and leave bundle.meta empty for documents, so the content panel
    // never received a status. It must now surface a slug-keyed map
    // (`meta[slug].status`), symmetric with a collection's id-keyed map.
    const git = {
      getTree: vi.fn(async () => [
        { path: '.contentrain/config.json', sha: 'c', type: 'blob' as const },
        { path: '.contentrain/models/guide-sections.json', sha: 'm', type: 'blob' as const },
        { path: '.contentrain/content/blog/guide-sections/intro/tr.md', sha: 'd1', type: 'blob' as const },
        { path: '.contentrain/content/blog/guide-sections/setup/tr.md', sha: 'd2', type: 'blob' as const },
      ]),
      readFile: vi.fn(async (path: string) => {
        if (path === '.contentrain/config.json') {
          return JSON.stringify({ stack: 'nuxt', domains: ['blog'], workflow: 'auto-merge', locales: { default: 'tr', supported: ['tr'] } })
        }
        if (path === '.contentrain/models/guide-sections.json') {
          return JSON.stringify({ id: 'guide-sections', name: 'Guide Sections', kind: 'document', domain: 'blog', i18n: true, fields: { title: { type: 'string' } } })
        }
        if (path === '.contentrain/content/blog/guide-sections/intro/tr.md') return '---\ntitle: Intro\n---\nHello\n'
        if (path === '.contentrain/content/blog/guide-sections/setup/tr.md') return '---\ntitle: Setup\n---\nWorld\n'
        if (path === '.contentrain/meta/guide-sections/intro/tr.json') return JSON.stringify({ status: 'published', updated_by: 'a@b.c' })
        if (path === '.contentrain/meta/guide-sections/setup/tr.json') return JSON.stringify({ status: 'draft' })
        throw new Error(`Unexpected read: ${path}`)
      }),
      listDirectory: vi.fn(async (path: string) => {
        if (path === '.contentrain/models') return ['guide-sections.json']
        if (path === '.contentrain/content/blog/guide-sections') return ['intro', 'setup']
        return []
      }),
    }

    // The suite's beforeEach stubs resolveMetaPath to a single fixed path; a
    // document needs the real per-slug shape so each slug maps to its own file.
    vi.stubGlobal('resolveMetaPath', vi.fn((_ctx: unknown, _model: unknown, locale: string, _defaultLocale: string, slug?: string) =>
      slug ? `.contentrain/meta/guide-sections/${slug}/${locale}.json` : `.contentrain/meta/guide-sections/${locale}.json`))

    const mod = await import('../../server/utils/brain-cache')
    const brain = await mod.buildBrainSnapshot(git as never, '', 'project-doc-meta')

    const meta = brain.meta.get('guide-sections:tr') as Record<string, { status?: string }> | undefined
    expect(meta).toBeDefined()
    expect(meta!.intro?.status).toBe('published')
    expect(meta!.setup?.status).toBe('draft')

    // The redundant per-entry `meta` nesting is gone — status lives only in the map.
    const docs = brain.content.get('guide-sections:tr') as Array<Record<string, unknown>>
    expect(docs.every(d => !('meta' in d))).toBe(true)
  })
})
