import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContentEngine } from '../../server/utils/content-engine'
import { validateContent } from '../../server/utils/content-validation'
import type { GitProvider } from '../../server/providers/git'
import {
  resolveConfigPath,
  resolveContentPath,
  resolveContextPath,
  resolveMetaPath,
  resolveModelPath,
  resolveModelsDir,
  resolveVocabularyPath,
} from '../../server/utils/content-paths'

const defaultCommit = {
  sha: 'commit-sha',
  message: 'noop',
  author: { name: 'bot', email: 'bot@example.com' },
  timestamp: '2026-03-25T00:00:00.000Z',
}

function createGitProvider(overrides: Partial<GitProvider> = {}): GitProvider {
  return {
    capabilities: {
      localWorktree: false,
      sourceRead: false,
      sourceWrite: false,
      pushRemote: true,
      branchProtection: true,
      pullRequestFallback: true,
      astScan: false,
    },
    getTree: vi.fn(),
    readFile: vi.fn(),
    listDirectory: vi.fn().mockResolvedValue([]),
    fileExists: vi.fn().mockResolvedValue(false),
    createBranch: vi.fn(),
    listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'abc', protected: false }]),
    getBranchDiff: vi.fn().mockResolvedValue([]),
    mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'merge-sha', pullRequestUrl: null }),
    deleteBranch: vi.fn(),
    applyPlan: vi.fn().mockResolvedValue(defaultCommit),
    commitFiles: vi.fn().mockResolvedValue(defaultCommit),
    createPR: vi.fn(),
    mergePR: vi.fn(),
    getPermissions: vi.fn(),
    getBranchProtection: vi.fn(),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    detectFramework: vi.fn(),
    isMerged: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as unknown as GitProvider
}

describe('content engine', () => {
  beforeEach(() => {
    vi.stubGlobal('resolveModelPath', resolveModelPath)
    vi.stubGlobal('resolveContentPath', resolveContentPath)
    vi.stubGlobal('resolveMetaPath', resolveMetaPath)
    vi.stubGlobal('resolveContextPath', resolveContextPath)
    vi.stubGlobal('resolveConfigPath', resolveConfigPath)
    vi.stubGlobal('resolveVocabularyPath', resolveVocabularyPath)
    vi.stubGlobal('resolveModelsDir', resolveModelsDir)
    // `validateContent` is a Nuxt server auto-import in production; wire the
    // real implementation so the engine validates against actual schema rules.
    vi.stubGlobal('validateContent', validateContent)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sanitizes invalid document slugs before touching git', async () => {
    const git = createGitProvider()
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.saveDocument('docs', 'en', '!!!', {}, 'body', 'user@example.com')

    expect(result.validation.valid).toBe(false)
    expect(result.validation.errors[0]?.field).toBe('slug')
    expect(git.readFile).not.toHaveBeenCalled()
    expect(git.applyPlan).not.toHaveBeenCalled()
  })

  it('validates a document when slug arrives as a separate argument, not inside frontmatter', async () => {
    const model = {
      id: 'blog-post',
      kind: 'document',
      i18n: true,
      domain: 'editorial',
      fields: {
        title: { type: 'string', required: true },
        slug: { type: 'slug', required: true, unique: true },
        author: { type: 'relation', model: 'author', required: true },
        published_at: { type: 'date', required: true },
      },
    }
    const config = { domains: ['editorial'], locales: { default: 'en', supported: ['en'] }, stack: 'astro', version: 1, workflow: 'auto-merge' }
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.includes('/models/blog-post')) return JSON.stringify(model)
        if (path.endsWith('config.json')) return JSON.stringify(config)
        throw new Error(`not found: ${path}`)
      }),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    // Frontmatter intentionally OMITS slug — it arrives as the dedicated
    // `slug` argument, exactly how the chat agent's save_content tool calls
    // it for documents. Previously this tripped a false "Required field is
    // missing or empty" on `slug` and aborted before any git write.
    const result = await engine.saveDocument(
      'blog-post',
      'en',
      'redbull-dogusu-ve-pazarlama-stratejisi',
      { title: 'Red Bull', author: 'esra-yilmaz', published_at: '2024-12-21' },
      'Body content.',
      'user@example.com',
      { autoPublish: true },
    )

    expect(result.validation.errors.find(e => e.field === 'slug')).toBeUndefined()
    expect(result.validation.valid).toBe(true)
    expect(applyPlan).toHaveBeenCalled()
  })

  const docModel = {
    id: 'blog-post',
    kind: 'document',
    i18n: true,
    domain: 'editorial',
    fields: {
      title: { type: 'string', required: true },
      slug: { type: 'slug', required: true, unique: true },
      author: { type: 'relation', model: 'author', required: true },
      cover_image: { type: 'image' },
    },
  }
  const docConfig = { domains: ['editorial'], locales: { default: 'en', supported: ['en'] }, stack: 'astro', version: 1, workflow: 'auto-merge' }
  const existingDoc = `---\ntitle: Original Title\nauthor: esra-yilmaz\n---\nOriginal body paragraph.\n`

  it('merges a partial document update with the existing entry (preserves body + untouched fields)', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.includes('/models/blog-post')) return JSON.stringify(docModel)
        if (path.endsWith('config.json')) return JSON.stringify(docConfig)
        // Require the {modelId} segment — documents live at
        // .contentrain/content/{domain}/{modelId}/{slug}/{locale}.md, so a
        // path missing /blog-post/ (the old PATH_PATTERNS bug) must 404.
        if (path.includes('/blog-post/') && path.includes('calm-interfaces') && path.endsWith('.md')) return existingDoc
        throw new Error(`not found: ${path}`)
      }),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    // Agent edits ONLY the cover image — no title/author, empty body. Without
    // the read-merge this failed "author is required" and wiped the body.
    const result = await engine.saveDocument(
      'blog-post', 'en', 'calm-interfaces',
      { cover_image: 'https://cdn.example.com/x.webp' }, '', 'user@example.com',
    )

    expect(result.validation.valid).toBe(true)
    expect(applyPlan).toHaveBeenCalled()
    const changes = applyPlan.mock.calls[0]![0].changes as Array<{ path: string, content: string | null }>
    const md = changes.find(c => c.path.endsWith('.md'))?.content ?? ''
    expect(md).toContain('Original body paragraph.') // body preserved
    expect(md).toContain('Original Title') // untouched field preserved
    expect(md).toContain('x.webp') // new field applied
  })

  it('routes a manual document save ({ [slug]: fields }) to saveDocument and merges', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.includes('/models/blog-post')) return JSON.stringify(docModel)
        if (path.endsWith('config.json')) return JSON.stringify(docConfig)
        // Require the {modelId} segment — documents live at
        // .contentrain/content/{domain}/{modelId}/{slug}/{locale}.md, so a
        // path missing /blog-post/ (the old PATH_PATTERNS bug) must 404.
        if (path.includes('/blog-post/') && path.includes('calm-interfaces') && path.endsWith('.md')) return existingDoc
        throw new Error(`not found: ${path}`)
      }),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    // The content route addresses a document as { [slug]: dirtyFields }. This
    // used to fall through saveContent with no slug → "Document entries require
    // a slug". Now it routes to saveDocument + merges.
    const result = await engine.saveContent(
      'blog-post', 'en',
      { 'calm-interfaces': { title: 'Updated Title' } },
      'user@example.com',
    )

    expect(result.validation.errors.find(e => e.message.toLowerCase().includes('slug'))).toBeUndefined()
    expect(result.validation.valid).toBe(true)
    expect(applyPlan).toHaveBeenCalled()
    const changes = applyPlan.mock.calls[0]![0].changes as Array<{ path: string, content: string | null }>
    const md = changes.find(c => c.path.endsWith('.md'))?.content ?? ''
    expect(md).toContain('Updated Title') // applied
    expect(md).toContain('esra-yilmaz') // author preserved via merge
    expect(md).toContain('Original body paragraph.') // body preserved
  })

  it('validates a new collection entry against a dynamic schema and proceeds to write', async () => {
    const model = {
      id: 'product',
      kind: 'collection',
      i18n: true,
      domain: 'catalog',
      fields: {
        title: { type: 'string', required: true },
        slug: { type: 'slug', required: true, unique: true },
        price: { type: 'integer', required: true },
      },
    }
    const config = { domains: ['catalog'], locales: { default: 'en', supported: ['en'] }, stack: 'astro', version: 1, workflow: 'auto-merge' }
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.includes('/models/product')) return JSON.stringify(model)
        if (path.endsWith('config.json')) return JSON.stringify(config)
        throw new Error(`not found: ${path}`)
      }),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.saveContent(
      'product',
      'en',
      { 'product-1': { title: 'Widget', slug: 'widget', price: 1200 } },
      'user@example.com',
      { autoPublish: true },
    )

    expect(result.validation.valid).toBe(true)
    expect(applyPlan).toHaveBeenCalled()
  })

  it('merges a partial collection update with the existing entry (preserves untouched fields)', async () => {
    // Regression: save_content advertises "MERGES with existing data — only
    // send changed fields", but MCP's planContentSave replaces an entry
    // wholesale. A partial field edit must NOT drop the untouched fields.
    const model = {
      id: 'faq',
      kind: 'collection',
      i18n: true,
      domain: 'marketing',
      fields: {
        question: { type: 'string', required: true },
        answer: { type: 'text', required: true },
        order: { type: 'integer', required: true },
      },
    }
    const config = { domains: ['marketing'], locales: { default: 'en', supported: ['en'] }, stack: 'astro', version: 1, workflow: 'auto-merge' }
    const existing = { faq1: { question: 'How long does it take?', answer: 'It depends.', order: 4 } }
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.includes('/models/faq')) return JSON.stringify(model)
        if (path.endsWith('config.json')) return JSON.stringify(config)
        if (path.includes('/faq/') && path.endsWith('en.json')) return JSON.stringify(existing)
        throw new Error(`not found: ${path}`)
      }),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    // Agent sends ONLY `answer` — question + order must survive.
    const result = await engine.saveContent(
      'faq',
      'en',
      { faq1: { answer: 'The timeline depends on scope.' } },
      'user@example.com',
      { autoPublish: true },
    )

    expect(result.validation.valid).toBe(true)
    expect(applyPlan).toHaveBeenCalled()
    const changes = applyPlan.mock.calls[0]![0].changes as Array<{ path: string, content: string | null }>
    const contentChange = changes.find(c => c.path.endsWith('en.json'))
    const written = JSON.parse(contentChange!.content as string) as Record<string, Record<string, unknown>>
    expect(written.faq1).toMatchObject({
      question: 'How long does it take?', // untouched — preserved
      answer: 'The timeline depends on scope.', // edited — applied
      order: 4, // untouched — preserved
    })
  })

  it('rejects a collection entry missing a schema-required field before any write', async () => {
    const model = {
      id: 'product',
      kind: 'collection',
      i18n: true,
      domain: 'catalog',
      fields: {
        title: { type: 'string', required: true },
        slug: { type: 'slug', required: true, unique: true },
        price: { type: 'integer', required: true },
      },
    }
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.includes('/models/product')) return JSON.stringify(model)
        throw new Error(`not found: ${path}`)
      }),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    // `price` omitted — schema requires it, so validation must fail and no
    // branch/write should happen.
    const result = await engine.saveContent(
      'product',
      'en',
      { 'product-1': { title: 'Widget', slug: 'widget' } },
      'user@example.com',
      { autoPublish: true },
    )

    expect(result.validation.valid).toBe(false)
    expect(result.validation.errors.some(e => e.field === 'price')).toBe(true)
    expect(result.branch).toBe('')
    expect(git.applyPlan).not.toHaveBeenCalled()
  })

  it('validates a singleton against its schema and proceeds to write', async () => {
    const model = {
      id: 'site-settings',
      kind: 'singleton',
      i18n: true,
      domain: 'system',
      fields: {
        site_name: { type: 'string', required: true },
        tagline: { type: 'string' },
      },
    }
    const config = { domains: ['system'], locales: { default: 'en', supported: ['en'] }, stack: 'astro', version: 1, workflow: 'auto-merge' }
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.includes('/models/site-settings')) return JSON.stringify(model)
        if (path.endsWith('config.json')) return JSON.stringify(config)
        throw new Error(`not found: ${path}`)
      }),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.saveContent(
      'site-settings',
      'en',
      { site_name: 'Acme', tagline: 'We build things' },
      'user@example.com',
      { autoPublish: true },
    )

    expect(result.validation.valid).toBe(true)
    expect(applyPlan).toHaveBeenCalled()
  })

  it('stamps `updated_at` on a content write, in Studio\'s own meta override', async () => {
    // MCP mints `updated_at` too, but Studio replaces MCP's meta wholesale to
    // keep its own autoPublish / updated_by semantics. Without stamping it in
    // the override the field never survives a Studio write — and "sort by
    // recently edited" would have no data for the entries Studio users create.
    const model = {
      id: 'faq',
      kind: 'collection',
      i18n: true,
      domain: 'marketing',
      title_field: 'question',
      fields: { question: { type: 'string', required: true } },
    }
    const config = { domains: ['marketing'], locales: { default: 'en', supported: ['en'] }, stack: 'astro', version: 1, workflow: 'auto-merge' }
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.includes('/models/faq')) return JSON.stringify(model)
        if (path.endsWith('config.json')) return JSON.stringify(config)
        throw new Error(`not found: ${path}`)
      }),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const before = new Date().toISOString()
    await engine.saveContent(
      'faq',
      'en',
      { 'faq-1': { question: 'How do I connect a repository?' } },
      'user@example.com',
      { autoPublish: true },
    )

    const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string, content: string | null }> }
    const metaChange = call.changes.find(c => c.path === '.contentrain/meta/faq/en.json')
    const meta = JSON.parse(metaChange!.content!) as Record<string, { updated_at?: string, updated_by?: string, status?: string }>

    expect(meta['faq-1']?.updated_at).toBeDefined()
    expect(meta['faq-1']!.updated_at! >= before).toBe(true)
    // The stamp is added to, not instead of, what the override already owned.
    expect(meta['faq-1']?.updated_by).toBe('user@example.com')
    expect(meta['faq-1']?.status).toBe('published')
  })

  it('deletes merged content branches after a successful two-step merge', async () => {
    const git = createGitProvider({
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      mergeBranch: vi.fn().mockResolvedValue({
        merged: true,
        sha: 'merge-sha',
        pullRequestUrl: null,
      }),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.mergeBranch('cr/content/faq/en/1234567890-abcd')

    expect(git.mergeBranch).toHaveBeenCalledWith('cr/content/faq/en/1234567890-abcd', 'contentrain')
    expect(git.deleteBranch).toHaveBeenCalledWith('cr/content/faq/en/1234567890-abcd')
    expect(git.mergeBranch).toHaveBeenCalledWith('contentrain', 'main')
    expect(result).toEqual({
      merged: true,
      sha: 'merge-sha',
      pullRequestUrl: null,
      mainAdvance: 'advanced',
    })
  })

  it('regenerates context.json on contentrain after a successful merge', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'merge-sha', pullRequestUrl: null }),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    await engine.mergeBranch('cr/content/faq/en/1234567890-abcd')

    // Feature branches no longer carry context.json (MCP 1.5.0 model); it
    // is rebuilt on contentrain post-merge via a dedicated commit.
    expect(applyPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'contentrain',
        base: 'contentrain',
        changes: expect.arrayContaining([
          expect.objectContaining({ path: '.contentrain/context.json' }),
        ]),
      }),
    )
  })

  it('falls back to PR creation when branch protection blocks step 2 merge', async () => {
    const git = createGitProvider({
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      mergeBranch: vi.fn()
        .mockResolvedValueOnce({ merged: true, sha: 'step1-sha', pullRequestUrl: null })
        .mockRejectedValueOnce(new Error('protected branch: not allowed')),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      createPR: vi.fn().mockResolvedValue({
        id: 'pr-1',
        url: 'https://example.com/pr/1',
      }),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.mergeBranch('cr/content/faq/en/1234567890-abcd')

    expect(git.mergeBranch).toHaveBeenCalledWith('cr/content/faq/en/1234567890-abcd', 'contentrain')
    expect(git.mergeBranch).toHaveBeenCalledWith('contentrain', 'main')
    expect(git.createPR).toHaveBeenCalledWith(
      'contentrain',
      'main',
      'contentrain: advance content to main',
      'Auto-generated by Contentrain Studio.',
    )
    // `merged: true` — step 1 landed the content on contentrain before the
    // protected advance was attempted; the old `false` reported a landed save
    // as a failed one.
    expect(result).toEqual({
      merged: true,
      sha: null,
      pullRequestUrl: 'https://example.com/pr/1',
      mainAdvance: 'blocked_diverged',
    })
  })

  it('deletes collection entries and their meta records together', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const modelJson = JSON.stringify({
      id: 'faq',
      name: 'FAQ',
      kind: 'collection',
      domain: 'marketing',
      i18n: true,
      fields: {},
    })
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/faq.json')) return modelJson
        if (path.endsWith('/marketing/faq/en.json')) {
          return JSON.stringify({
            keep: { title: 'Keep' },
            drop: { title: 'Drop' },
          })
        }
        if (path.endsWith('/meta/faq/en.json')) {
          return JSON.stringify({
            keep: { status: 'published' },
            drop: { status: 'draft' },
          })
        }
        if (path.endsWith('/config.json')) {
          return JSON.stringify({ locales: { supported: ['en'], default: 'en' } })
        }
        throw new Error(`Unexpected path: ${path}`)
      }),
      listDirectory: vi.fn().mockResolvedValue(['faq.json']),
      listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      applyPlan,
      getBranchDiff: vi.fn().mockResolvedValue([]),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    await engine.deleteContent('faq', 'en', ['drop'], 'user@example.com')

    expect(applyPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: expect.stringMatching(/^cr\/content\/faq\/en\//),
        message: expect.stringContaining('contentrain: delete 1 entries from faq [en]'),
        base: 'contentrain',
        changes: expect.arrayContaining([
          expect.objectContaining({
            path: '.contentrain/content/marketing/faq/en.json',
            content: expect.stringContaining('"keep"'),
          }),
          expect.objectContaining({
            path: '.contentrain/meta/faq/en.json',
          }),
        ]),
      }),
    )

    // The dropped entry must not appear in the remaining content file.
    const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string, content: string | null }> }
    const contentChange = call.changes.find(c => c.path === '.contentrain/content/marketing/faq/en.json')
    expect(contentChange?.content).not.toMatch(/"drop"/)
  })

  it('updates entry status in meta without touching content files', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/faq.json')) {
          return JSON.stringify({
            id: 'faq',
            name: 'FAQ',
            kind: 'collection',
            domain: 'marketing',
            i18n: true,
            fields: {},
          })
        }
        if (path.endsWith('/meta/faq/en.json')) {
          return JSON.stringify({
            keep: { status: 'draft' },
          })
        }
        if (path.endsWith('/config.json')) {
          return JSON.stringify({ locales: { supported: ['en'], default: 'en' } })
        }
        throw new Error(`Unexpected path: ${path}`)
      }),
      listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
      listDirectory: vi.fn().mockResolvedValue(['faq.json']),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      applyPlan,
      getBranchDiff: vi.fn().mockResolvedValue([]),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    await engine.updateEntryStatus('faq', 'en', ['keep', 'new-entry'], 'published', 'user@example.com')

    expect(applyPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: expect.stringMatching(/^cr\/content\/faq\/en\//),
        message: expect.stringContaining('contentrain: published 2 entries in faq'),
        base: 'contentrain',
      }),
    )

    const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string, content: string | null }> }
    const metaChange = call.changes.find(c => c.path === '.contentrain/meta/faq/en.json')
    expect(metaChange?.content).toContain('"status": "published"')
    expect(metaChange?.content).toContain('"updated_by": "user@example.com"')
    expect(metaChange?.content).toContain('"new-entry"')

    // A status change is a write, so it carries the same `updated_at` stamp a
    // content write does — one timestamp shared across the entries of the call,
    // because it was one operation.
    const meta = JSON.parse(metaChange!.content!) as Record<string, { updated_at?: string }>
    expect(meta.keep?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    expect(meta['new-entry']?.updated_at).toBe(meta.keep?.updated_at)
  })

  it('reports every entry\'s status transition, including the ones it did not touch', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/articles.json')) {
          return JSON.stringify({ id: 'articles', name: 'Articles', kind: 'collection', domain: 'blog', i18n: true, fields: {} })
        }
        if (path.endsWith('/meta/articles/tr.json')) {
          return JSON.stringify({
            'was-draft': { status: 'draft', source: 'agent', updated_by: 'someone@else.com', updated_at: '2026-08-24T13:19:15.949Z' },
            'already-live': { status: 'published', source: 'agent', updated_by: 'someone@else.com', updated_at: '2026-08-24T13:19:15.949Z' },
          })
        }
        if (path.endsWith('/config.json')) return JSON.stringify({ locales: { supported: ['tr'], default: 'tr' } })
        throw new Error(`Unexpected path: ${path}`)
      }),
      listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      applyPlan,
      getBranchDiff: vi.fn().mockResolvedValue([]),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.updateEntryStatus(
      'articles', 'tr', ['was-draft', 'already-live', 'no-meta'], 'published', 'user@example.com',
    )

    // The before/after of the whole batch — the fact that made the staging
    // incident possible was its absence: a status write looked exactly like a
    // status read, so "it was already published" was indistinguishable from
    // "I just published it".
    expect(result.statusChanges).toEqual([
      { entryId: 'was-draft', from: 'draft', to: 'published' },
      { entryId: 'already-live', from: 'published', to: 'published' },
      { entryId: 'no-meta', from: null, to: 'published' },
    ])

    // Only the two that actually moved get re-stamped; the entry that was
    // already published keeps its original author and timestamp.
    const call = applyPlan.mock.calls[0]?.[0] as { message: string, changes: Array<{ path: string, content: string | null }> }
    const meta = JSON.parse(call.changes[0]!.content!) as Record<string, { updated_by?: string, updated_at?: string }>
    expect(meta['already-live']?.updated_by).toBe('someone@else.com')
    expect(meta['already-live']?.updated_at).toBe('2026-08-24T13:19:15.949Z')
    expect(meta['was-draft']?.updated_by).toBe('user@example.com')
    expect(meta['no-meta']?.updated_by).toBe('user@example.com')
    expect(call.message).toContain('published 2 entries in articles')
  })

  it('writes nothing when every entry already carries the requested status', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/articles.json')) {
          return JSON.stringify({ id: 'articles', name: 'Articles', kind: 'collection', domain: 'blog', i18n: true, fields: {} })
        }
        if (path.endsWith('/meta/articles/tr.json')) {
          return JSON.stringify({ a: { status: 'published' }, b: { status: 'published' } })
        }
        if (path.endsWith('/config.json')) return JSON.stringify({ locales: { supported: ['tr'], default: 'tr' } })
        throw new Error(`Unexpected path: ${path}`)
      }),
      listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      applyPlan,
      getBranchDiff: vi.fn().mockResolvedValue([]),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.updateEntryStatus('articles', 'tr', ['a', 'b'], 'published', 'user@example.com')

    // A save no-op is caught by the byte-identical plan check; a status no-op
    // is not, because `updated_at` differs on every call. Without this guard
    // an inert publish still cost a branch, a merge round and a CDN rebuild.
    expect(result.unchanged).toBe(true)
    expect(result.branch).toBe('')
    expect(applyPlan).not.toHaveBeenCalled()
    expect(result.statusChanges).toEqual([
      { entryId: 'a', from: 'published', to: 'published' },
      { entryId: 'b', from: 'published', to: 'published' },
    ])
  })

  it('skips document slugs that already carry the requested status', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/guide-sections.json')) {
          return JSON.stringify({ id: 'guide-sections', name: 'Guide Sections', kind: 'document', domain: 'blog', i18n: true, fields: {} })
        }
        if (path.endsWith('/meta/guide-sections/instagram-1/tr.json')) return JSON.stringify({ status: 'published' })
        if (path.endsWith('/meta/guide-sections/youtube-4/tr.json')) return JSON.stringify({ status: 'draft' })
        if (path.endsWith('/config.json')) return JSON.stringify({ locales: { supported: ['tr'], default: 'tr' } })
        throw new Error(`Unexpected path: ${path}`)
      }),
      listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      applyPlan,
      getBranchDiff: vi.fn().mockResolvedValue([]),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.updateEntryStatus('guide-sections', 'tr', ['instagram-1', 'youtube-4'], 'published', 'user@example.com')

    const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string }> }
    expect(call.changes.map(c => c.path)).toEqual(['.contentrain/meta/guide-sections/youtube-4/tr.json'])
    expect(result.statusChanges).toEqual([
      { entryId: 'instagram-1', from: 'published', to: 'published' },
      { entryId: 'youtube-4', from: 'draft', to: 'published' },
    ])
  })

  it('updates document status via per-slug meta files (no malformed `//` path)', async () => {
    // Regression: documents store meta at `.../{modelId}/{slug}/{locale}.json`.
    // Passing no slug to resolveMetaPath produced `.../guide-sections//tr.json`,
    // which GitHub's tree API rejects as a malformed path component. Each entryId
    // is a slug and gets its own top-level EntryMeta file (not an id-keyed map).
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/guide-sections.json')) {
          return JSON.stringify({
            id: 'guide-sections',
            name: 'Guide Sections',
            kind: 'document',
            domain: 'blog',
            i18n: true,
            fields: {},
          })
        }
        if (path.endsWith('/meta/guide-sections/instagram-1/tr.json')) {
          return JSON.stringify({ status: 'draft', source: 'agent' })
        }
        if (path.endsWith('/config.json')) {
          return JSON.stringify({ locales: { supported: ['tr'], default: 'tr' } })
        }
        throw new Error(`Unexpected path: ${path}`)
      }),
      listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      applyPlan,
      getBranchDiff: vi.fn().mockResolvedValue([]),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    await engine.updateEntryStatus('guide-sections', 'tr', ['instagram-1', 'youtube-4'], 'published', 'user@example.com')

    const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string, content: string | null }> }
    // One meta file per slug, at the per-slug document path — and never a `//`.
    const paths = call.changes.map(c => c.path)
    expect(paths).toContain('.contentrain/meta/guide-sections/instagram-1/tr.json')
    expect(paths).toContain('.contentrain/meta/guide-sections/youtube-4/tr.json')
    expect(paths.some(p => p.includes('//'))).toBe(false)

    // Each file is a single top-level EntryMeta object, not an id-keyed map.
    const first = call.changes.find(c => c.path.endsWith('/instagram-1/tr.json'))
    const firstMeta = JSON.parse(first!.content as string) as Record<string, unknown>
    expect(firstMeta.status).toBe('published')
    expect(firstMeta.updated_by).toBe('user@example.com')
    expect(firstMeta.source).toBe('agent') // preserved from existing meta
    expect(firstMeta).not.toHaveProperty('instagram-1')
  })

  it('rejects a document status update when a slug is malformed', async () => {
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/guide-sections.json')) {
          return JSON.stringify({
            id: 'guide-sections',
            name: 'Guide Sections',
            kind: 'document',
            domain: 'blog',
            i18n: true,
            fields: {},
          })
        }
        if (path.endsWith('/config.json')) return JSON.stringify({ locales: { default: 'en', supported: ['en', 'tr'] } })
        throw new Error(`Unexpected path: ${path}`)
      }),
      listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.updateEntryStatus('guide-sections', 'tr', [''], 'published', 'user@example.com')
    expect(result.validation.valid).toBe(false)
    expect(git.applyPlan).not.toHaveBeenCalled()
  })

  it('rejects locale copy on models without i18n support', async () => {
    const git = createGitProvider({
      readFile: vi.fn(async () => JSON.stringify({
        id: 'settings',
        name: 'Settings',
        kind: 'singleton',
        domain: 'system',
        i18n: false,
        fields: {},
      })),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.copyLocale('settings', 'en', 'tr', 'user@example.com')

    expect(result.validation.valid).toBe(false)
    expect(result.validation.errors[0]?.message).toBe('Model does not support i18n')
  })

  it('copies a document locale per-slug (content + per-slug meta, no malformed path)', async () => {
    // Documents store content + meta per-slug; the single-file copy path read the
    // content *directory* as a file (→ "source locale not found") and wrote a
    // slug-less `//` meta path. The copy must enumerate slugs and copy each pair.
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/guide-sections.json')) {
          return JSON.stringify({
            id: 'guide-sections',
            name: 'Guide Sections',
            kind: 'document',
            domain: 'blog',
            i18n: true,
            fields: {},
          })
        }
        if (path.endsWith('/intro/en.md')) return '---\ntitle: Intro\n---\nHello'
        if (path.endsWith('/setup/en.md')) return '---\ntitle: Setup\n---\nWorld'
        if (path.endsWith('/meta/guide-sections/intro/en.json')) return JSON.stringify({ status: 'published' })
        if (path.endsWith('/meta/guide-sections/setup/en.json')) return JSON.stringify({ status: 'draft' })
        if (path.endsWith('/config.json')) return JSON.stringify({ locales: { default: 'en', supported: ['en', 'tr'] } })
        // Any target-locale (tr) read → not found → copy proceeds.
        throw new Error(`Unexpected path: ${path}`)
      }),
      listDirectory: vi.fn(async (path: string) => {
        if (path.endsWith('/content/blog/guide-sections')) return ['intro', 'setup']
        return []
      }),
      listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      applyPlan,
      getBranchDiff: vi.fn().mockResolvedValue([]),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.copyLocale('guide-sections', 'en', 'tr', 'user@example.com')
    expect(result.validation.valid).toBe(true)

    const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string, content: string | null }> }
    const paths = call.changes.map(c => c.path)
    // Per-slug content + meta for the target locale, never a `//` segment.
    expect(paths).toContain('.contentrain/content/blog/guide-sections/intro/tr.md')
    expect(paths).toContain('.contentrain/content/blog/guide-sections/setup/tr.md')
    expect(paths).toContain('.contentrain/meta/guide-sections/intro/tr.json')
    expect(paths).toContain('.contentrain/meta/guide-sections/setup/tr.json')
    expect(paths.some(p => p.includes('//'))).toBe(false)

    // Copied meta carries the source status verbatim.
    const introMeta = call.changes.find(c => c.path.endsWith('/meta/guide-sections/intro/tr.json'))
    expect(JSON.parse(introMeta!.content as string).status).toBe('published')
  })

  describe('locale-agnostic fields land in every locale of an i18n model', () => {
    const config = { domains: ['system', 'editorial'], locales: { default: 'tr', supported: ['tr', 'en'] }, stack: 'nuxt', version: 1, workflow: 'auto-merge' }
    const siteSettings = {
      id: 'site-settings',
      name: 'Site Settings',
      kind: 'singleton',
      domain: 'system',
      i18n: true,
      title_field: 'title',
      fields: {
        title: { type: 'string' },
        guides_band_background: { type: 'image' },
        featured_report: { type: 'relation', model: 'reports' },
      },
    }

    function fileChanges(applyPlan: ReturnType<typeof vi.fn>) {
      const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string, content: string }>, message: string }
      return {
        message: call.message,
        read: (suffix: string) => {
          const change = call.changes.find(c => c.path.endsWith(suffix))
          return change ? JSON.parse(change.content) : null
        },
      }
    }

    function singletonGit(files: Record<string, unknown>) {
      const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
      const git = createGitProvider({
        readFile: vi.fn(async (path: string) => {
          if (path.endsWith('/config.json')) return JSON.stringify(config)
          if (path.endsWith('/models/site-settings.json')) return JSON.stringify(siteSettings)
          const hit = Object.entries(files).find(([suffix]) => path.endsWith(suffix))
          if (hit) return JSON.stringify(hit[1])
          throw new Error(`Missing file: ${path}`)
        }),
        listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
        applyPlan,
      })
      return { git, applyPlan }
    }

    it('writes a swapped image to the other locale in the same commit, keeping its prose', async () => {
      // The report: en got the new asset, tr kept the old one, the site rendered tr.
      const { git, applyPlan } = singletonGit({
        '/content/system/site-settings/en.json': { title: 'Site', guides_band_background: 'https://cdn/old.webp' },
        '/content/system/site-settings/tr.json': { title: 'Site (TR)', guides_band_background: 'https://cdn/old.webp' },
        '/meta/site-settings/tr.json': { status: 'published' },
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveContent('site-settings', 'en', { guides_band_background: 'https://cdn/new.webp' }, 'editor@example.com')

      expect(result.validation.valid).toBe(true)
      expect(result.sharedAcrossLocales).toEqual({ fields: ['guides_band_background'], locales: ['tr'] })
      const files = fileChanges(applyPlan)
      expect(files.read('/content/system/site-settings/en.json').guides_band_background).toBe('https://cdn/new.webp')
      expect(files.read('/content/system/site-settings/tr.json')).toEqual({ title: 'Site (TR)', guides_band_background: 'https://cdn/new.webp' })
      // Studio's meta semantics reach the fan-out locale too: status kept, author stamped.
      const trMeta = files.read('/meta/site-settings/tr.json')
      expect(trMeta.status).toBe('published')
      expect(trMeta.updated_by).toBe('editor@example.com')
      expect(files.message).toContain('Shared across locales (tr): guides_band_background')
    })

    it('leaves the other locale alone for prose', async () => {
      const { git, applyPlan } = singletonGit({
        '/content/system/site-settings/en.json': { title: 'Site', guides_band_background: 'https://cdn/old.webp' },
        '/content/system/site-settings/tr.json': { title: 'Site (TR)', guides_band_background: 'https://cdn/old.webp' },
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveContent('site-settings', 'en', { title: 'New title' }, 'editor@example.com')

      expect(result.sharedAcrossLocales).toBeUndefined()
      expect(fileChanges(applyPlan).read('/content/system/site-settings/tr.json')).toBeNull()
    })

    it('leaves a locale alone that already holds the value, so a no-op stays a no-op', async () => {
      const { git, applyPlan } = singletonGit({
        '/content/system/site-settings/en.json': { title: 'Site', guides_band_background: 'https://cdn/old.webp' },
        '/content/system/site-settings/tr.json': { title: 'Site (TR)', guides_band_background: 'https://cdn/new.webp' },
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveContent('site-settings', 'en', { guides_band_background: 'https://cdn/new.webp' }, 'editor@example.com')

      expect(result.sharedAcrossLocales).toBeUndefined()
      expect(fileChanges(applyPlan).read('/content/system/site-settings/tr.json')).toBeNull()
    })

    it('carries a relation into the other locale only for entries that exist there', async () => {
      const articles = {
        id: 'articles',
        name: 'Articles',
        kind: 'collection',
        domain: 'editorial',
        i18n: true,
        title_field: 'title',
        fields: { title: { type: 'string' }, author: { type: 'relation', model: 'authors' }, cover: { type: 'image' } },
      }
      const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
      const git = createGitProvider({
        readFile: vi.fn(async (path: string) => {
          if (path.endsWith('/config.json')) return JSON.stringify(config)
          if (path.endsWith('/models/articles.json')) return JSON.stringify(articles)
          if (path.endsWith('/articles/en.json')) return JSON.stringify({ a1: { title: 'One', author: 'old' }, b2: { title: 'Two', author: 'old' } })
          if (path.endsWith('/articles/tr.json')) return JSON.stringify({ a1: { title: 'Bir', author: 'old' } })
          throw new Error(`Missing file: ${path}`)
        }),
        listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
        applyPlan,
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveContent('articles', 'en', {
        a1: { author: 'new', title: 'One!' },
        b2: { author: 'new' },
      }, 'editor@example.com')

      expect(result.validation.valid).toBe(true)
      expect(result.sharedAcrossLocales).toEqual({ fields: ['author'], locales: ['tr'] })
      const tr = fileChanges(applyPlan).read('/articles/tr.json')
      // a1 exists in tr: relation carried, Turkish title untouched. b2 does not: a
      // locale-coverage gap this save was not asked to fill.
      expect(tr).toEqual({ a1: { title: 'Bir', author: 'new' } })
      const trMeta = fileChanges(applyPlan).read('/meta/articles/tr.json')
      expect(Object.keys(trMeta)).toEqual(['a1'])
      expect(trMeta.a1.updated_by).toBe('editor@example.com')
    })

    it('does nothing extra for a model that is not i18n', async () => {
      const { git, applyPlan } = singletonGit({
        '/content/system/site-settings/data.json': { title: 'Site', guides_band_background: 'https://cdn/old.webp' },
      })
      ;(git.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
        if (path.endsWith('/config.json')) return JSON.stringify(config)
        if (path.endsWith('/models/site-settings.json')) return JSON.stringify({ ...siteSettings, i18n: false })
        if (path.endsWith('/site-settings/data.json')) return JSON.stringify({ title: 'Site', guides_band_background: 'https://cdn/old.webp' })
        throw new Error(`Missing file: ${path}`)
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveContent('site-settings', 'tr', { guides_band_background: 'https://cdn/new.webp' }, 'editor@example.com')

      expect(result.validation.valid).toBe(true)
      expect(result.sharedAcrossLocales).toBeUndefined()
      const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string }> }
      expect(call.changes.filter(c => c.path.includes('/content/')).map(c => c.path)).toEqual(['.contentrain/content/system/site-settings/data.json'])
    })

    it('carries a document cover into the other locale, keeping that locale\'s body', async () => {
      const guides = {
        id: 'guides',
        name: 'Guides',
        kind: 'document',
        domain: 'editorial',
        i18n: true,
        title_field: 'title',
        fields: { title: { type: 'string', required: true }, cover: { type: 'image' } },
      }
      const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
      const git = createGitProvider({
        readFile: vi.fn(async (path: string) => {
          if (path.endsWith('/config.json')) return JSON.stringify(config)
          if (path.endsWith('/models/guides.json')) return JSON.stringify(guides)
          if (path.endsWith('/guides/intro/en.md')) return '---\ntitle: Intro\ncover: https://cdn/old.webp\n---\nEnglish body.\n'
          if (path.endsWith('/guides/intro/tr.md')) return '---\ntitle: Giriş\ncover: https://cdn/old.webp\n---\nTürkçe gövde.\n'
          throw new Error(`Missing file: ${path}`)
        }),
        listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
        applyPlan,
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveDocument('guides', 'en', 'intro', { cover: 'https://cdn/new.webp' }, '', 'editor@example.com')

      expect(result.validation.valid).toBe(true)
      expect(result.sharedAcrossLocales).toEqual({ fields: ['cover'], locales: ['tr'] })
      const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string, content: string }> }
      const tr = call.changes.find(c => c.path.endsWith('/guides/intro/tr.md'))!.content
      expect(tr).toContain('https://cdn/new.webp')
      expect(tr).not.toContain('old.webp')
      expect(tr).toContain('Giriş')
      expect(tr).toContain('Türkçe gövde.')
    })
  })

  describe('scheduling rides on meta, never on content, and never on status', () => {
    const config = { domains: ['editorial'], locales: { default: 'en', supported: ['en'] }, stack: 'nuxt', version: 1, workflow: 'auto-merge' }
    const articles = {
      id: 'articles',
      name: 'Articles',
      kind: 'collection',
      domain: 'editorial',
      i18n: true,
      title_field: 'title',
      fields: { title: { type: 'string', required: true } },
    }

    function gitWith(files: Record<string, unknown>) {
      const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
      const git = createGitProvider({
        readFile: vi.fn(async (path: string) => {
          if (path.endsWith('/config.json')) return JSON.stringify(config)
          if (path.endsWith('/models/articles.json')) return JSON.stringify(articles)
          const hit = Object.entries(files).find(([suffix]) => path.endsWith(suffix))
          if (hit) return typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1])
          throw new Error(`Missing file: ${path}`)
        }),
        listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
        applyPlan,
      })
      return { git, applyPlan }
    }

    function written(applyPlan: ReturnType<typeof vi.fn>, suffix: string) {
      const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string, content: string }> }
      const change = call.changes.find(c => c.path.endsWith(suffix))
      return change ? JSON.parse(change.content) : null
    }

    it('lands a schedule in meta with the status untouched', async () => {
      const { git, applyPlan } = gitWith({
        '/content/editorial/articles/en.json': { a1: { title: 'One' } },
        '/meta/articles/en.json': { a1: { status: 'draft', source: 'agent', updated_by: 'someone@else.com' } },
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveContent('articles', 'en', { a1: { title: 'One!' } }, 'editor@example.com', {
        schedule: { publish_at: '2026-10-01T09:00:00.000Z' },
      })

      expect(result.validation.valid).toBe(true)
      const meta = written(applyPlan, '/meta/articles/en.json')
      // The date is there, the draft is still a draft, and Studio's own
      // stamps are on top — the override used to rebuild meta from the prior
      // file and drop what the plan had just set.
      expect(meta.a1).toMatchObject({ status: 'draft', publish_at: '2026-10-01T09:00:00.000Z', updated_by: 'editor@example.com' })
      expect(written(applyPlan, '/content/editorial/articles/en.json').a1).toEqual({ title: 'One!' })
    })

    it('clears a date with null and leaves it alone when omitted', async () => {
      const { git, applyPlan } = gitWith({
        '/content/editorial/articles/en.json': { a1: { title: 'One' } },
        '/meta/articles/en.json': { a1: { status: 'published', publish_at: '2026-01-01T00:00:00.000Z', expire_at: '2026-12-31T00:00:00.000Z' } },
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      await engine.saveContent('articles', 'en', { a1: { title: 'One!' } }, 'editor@example.com', {
        schedule: { expire_at: null },
      })

      const meta = written(applyPlan, '/meta/articles/en.json')
      expect(meta.a1.publish_at).toBe('2026-01-01T00:00:00.000Z')
      expect('expire_at' in meta.a1).toBe(false)
      expect(meta.a1.status).toBe('published')
    })

    it('lifts a schedule the caller put inside data, so it never reaches the content file', async () => {
      const { git, applyPlan } = gitWith({
        '/content/editorial/articles/en.json': { a1: { title: 'One' } },
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      await engine.saveContent('articles', 'en', { a1: { title: 'One!', publish_at: '2026-10-01T09:00:00.000Z' } }, 'editor@example.com')

      expect(written(applyPlan, '/content/editorial/articles/en.json').a1).toEqual({ title: 'One!' })
      expect(written(applyPlan, '/meta/articles/en.json').a1.publish_at).toBe('2026-10-01T09:00:00.000Z')
    })

    it('refuses a date that is not a date, or an expiry before the publish date', async () => {
      const { git, applyPlan } = gitWith({})
      const engine = createContentEngine({ git, contentRoot: '' })

      const bad = await engine.saveContent('articles', 'en', { a1: { title: 'One' } }, 'editor@example.com', { schedule: { publish_at: 'next tuesday' } })
      expect(bad.validation.valid).toBe(false)
      expect(bad.validation.errors[0]?.message).toContain('Invalid publish_at date')

      const inverted = await engine.saveContent('articles', 'en', { a1: { title: 'One' } }, 'editor@example.com', {
        schedule: { publish_at: '2026-10-01T09:00:00.000Z', expire_at: '2026-09-01T09:00:00.000Z' },
      })
      expect(inverted.validation.valid).toBe(false)
      expect(inverted.validation.errors[0]?.message).toContain('must be after publish_at')
      expect(applyPlan).not.toHaveBeenCalled()
    })

    it('schedules a document by its slug meta and keeps the frontmatter clean', async () => {
      const guides = { ...articles, id: 'guides', kind: 'document', fields: { title: { type: 'string', required: true } } }
      const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
      const git = createGitProvider({
        readFile: vi.fn(async (path: string) => {
          if (path.endsWith('/config.json')) return JSON.stringify(config)
          if (path.endsWith('/models/guides.json')) return JSON.stringify(guides)
          if (path.endsWith('/guides/intro/en.md')) return '---\ntitle: Intro\npublish_at: 2026-01-01T00:00:00.000Z\n---\nBody.\n'
          throw new Error(`Missing file: ${path}`)
        }),
        listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
        applyPlan,
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveDocument('guides', 'en', 'intro', { title: 'Intro!' }, '', 'editor@example.com', {
        schedule: { publish_at: '2026-10-01T09:00:00.000Z' },
      })

      expect(result.validation.valid).toBe(true)
      const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string, content: string }> }
      const md = call.changes.find(c => c.path.endsWith('/guides/intro/en.md'))!.content
      // The value an older content_save leaked into the frontmatter is not
      // re-planted by this write; meta is where the schedule lives.
      expect(md).not.toContain('2026-10-01')
      const meta = JSON.parse(call.changes.find(c => c.path.endsWith('/meta/guides/intro/en.json'))!.content)
      expect(meta).toMatchObject({ publish_at: '2026-10-01T09:00:00.000Z', status: 'draft', updated_by: 'editor@example.com' })
    })
  })

  it('saves model definitions without committing context.json on the feature branch', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/config.json')) {
          return JSON.stringify({ locales: { supported: ['en'], default: 'en' } })
        }
        throw new Error(`Missing file: ${path}`)
      }),
      listDirectory: vi.fn().mockResolvedValue(['faq.json']),
      listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      applyPlan,
      getBranchDiff: vi.fn().mockResolvedValue([]),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    await engine.saveModel({
      id: 'authors',
      name: 'Authors',
      kind: 'collection',
      domain: 'marketing',
      i18n: true,
      fields: {
        name: { type: 'text' },
      },
    } as never, 'user@example.com')

    expect(applyPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: expect.stringMatching(/^cr\/model\/authors\//),
        message: expect.stringContaining('contentrain: save model authors'),
        base: 'contentrain',
        changes: expect.arrayContaining([
          expect.objectContaining({ path: '.contentrain/models/authors.json' }),
        ]),
      }),
    )

    // context.json is regenerated on contentrain post-merge (MCP 1.5.0
    // model), never committed on the feature branch.
    const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string }> }
    expect(call.changes.some(c => c.path.endsWith('context.json'))).toBe(false)
  })

  describe('saveModel merges with the definition on contentrain', () => {
    const homePage = {
      id: 'home-page',
      name: 'Home Page',
      kind: 'singleton',
      domain: 'marketing',
      i18n: true,
      title_field: 'hero_title',
      description: 'Landing page',
      fields: {
        hero_title: { type: 'string', required: true },
        hero_subtitle: { type: 'text' },
        pricing_preview: { type: 'object', fields: { headline: { type: 'string' } } },
      },
    }
    const config = { domains: ['marketing'], locales: { default: 'tr', supported: ['tr', 'en'] }, stack: 'nuxt', version: 1, workflow: 'auto-merge' }

    function gitWith(content: Record<string, unknown>, overrides: Partial<GitProvider> = {}) {
      const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
      const git = createGitProvider({
        readFile: vi.fn(async (path: string) => {
          if (path.endsWith('/config.json')) return JSON.stringify(config)
          if (path.endsWith('/models/home-page.json')) return JSON.stringify(homePage)
          const hit = Object.entries(content).find(([suffix]) => path.endsWith(suffix))
          if (hit) return JSON.stringify(hit[1])
          throw new Error(`Missing file: ${path}`)
        }),
        listDirectory: vi.fn().mockResolvedValue(['home-page.json']),
        listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
        applyPlan,
        ...overrides,
      })
      return { git, applyPlan }
    }

    function savedModel(applyPlan: ReturnType<typeof vi.fn>) {
      const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string, content: string }> }
      const change = call.changes.find(c => c.path.endsWith('/models/home-page.json'))
      return JSON.parse(change!.content) as typeof homePage
    }

    it('keeps every field a one-field payload did not mention', async () => {
      // Exactly the iterum payload that wiped 38 of 39 fields.
      const { git, applyPlan } = gitWith({})
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveModel({
        id: 'home-page',
        name: 'Home Page',
        kind: 'singleton',
        domain: 'marketing',
        i18n: true,
        fields: { hero_background_image: { type: 'image', description: 'Hero banner' } },
      } as never, 'user@example.com')

      expect(result.validation.valid).toBe(true)
      const saved = savedModel(applyPlan)
      expect(Object.keys(saved.fields).toSorted()).toEqual(['hero_background_image', 'hero_subtitle', 'hero_title', 'pricing_preview'])
      expect(saved.title_field).toBe('hero_title')
      expect(saved.description).toBe('Landing page')
      expect(result.modelChange).toEqual({
        action: 'updated',
        addedFields: ['hero_background_image'],
        changedFields: [],
        removedFields: [],
        keptFields: 3,
      })
    })

    it('refuses to drop a field that entries still carry, and says how many', async () => {
      const { git, applyPlan } = gitWith({
        '/home-page/tr.json': { hero_title: 'Merhaba', pricing_preview: { headline: 'Fiyatlar' } },
        '/home-page/en.json': { hero_title: 'Hello', pricing_preview: { headline: 'Pricing' } },
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveModel({ id: 'home-page', name: 'Home Page', kind: 'singleton', domain: 'marketing', i18n: true } as never, 'user@example.com', {
        removeFields: ['pricing_preview'],
      })

      expect(result.validation.valid).toBe(false)
      expect(result.validation.errors[0]?.field).toBe('pricing_preview')
      expect(result.validation.errors[0]?.message).toContain('still used by 1 entry')
      expect(result.breakingChanges).toEqual([
        { kind: 'field_removed', field: 'pricing_preview', from: 'object', affectedEntries: 1 },
      ])
      expect(applyPlan).not.toHaveBeenCalled()
    })

    it('drops a field nobody uses without ceremony', async () => {
      const { git, applyPlan } = gitWith({
        '/home-page/tr.json': { hero_title: 'Merhaba', pricing_preview: {} },
        '/home-page/en.json': { hero_title: 'Hello' },
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveModel({ id: 'home-page', name: 'Home Page', kind: 'singleton', domain: 'marketing', i18n: true } as never, 'user@example.com', {
        removeFields: ['pricing_preview'],
      })

      expect(result.validation.valid).toBe(true)
      expect(savedModel(applyPlan).fields.pricing_preview).toBeUndefined()
      expect(result.modelChange?.removedFields).toEqual(['pricing_preview'])
    })

    it('drops a used field when the removal is confirmed', async () => {
      const { git, applyPlan } = gitWith({
        '/home-page/tr.json': { hero_title: 'Merhaba', pricing_preview: { headline: 'Fiyatlar' } },
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveModel({ id: 'home-page', name: 'Home Page', kind: 'singleton', domain: 'marketing', i18n: true } as never, 'user@example.com', {
        removeFields: ['pricing_preview'],
        allowBreaking: true,
      })

      expect(result.validation.valid).toBe(true)
      expect(savedModel(applyPlan).fields.pricing_preview).toBeUndefined()
    })

    it('refuses a type change on a field entries still carry, counting entries once across locales', async () => {
      const collection = { ...homePage, kind: 'collection', title_field: 'hero_title' }
      const { git, applyPlan } = gitWith({
        '/home-page/tr.json': { a1: { hero_title: 'Bir', hero_subtitle: 'x' }, b2: { hero_title: 'İki', hero_subtitle: 'y' } },
        '/home-page/en.json': { a1: { hero_title: 'One', hero_subtitle: 'x' } },
      }, {
        readFile: vi.fn(async (path: string) => {
          if (path.endsWith('/config.json')) return JSON.stringify(config)
          if (path.endsWith('/models/home-page.json')) return JSON.stringify(collection)
          if (path.endsWith('/home-page/tr.json')) return JSON.stringify({ a1: { hero_title: 'Bir', hero_subtitle: 'x' }, b2: { hero_title: 'İki', hero_subtitle: 'y' } })
          if (path.endsWith('/home-page/en.json')) return JSON.stringify({ a1: { hero_title: 'One', hero_subtitle: 'x' } })
          throw new Error(`Missing file: ${path}`)
        }),
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveModel({
        id: 'home-page',
        name: 'Home Page',
        kind: 'collection',
        domain: 'marketing',
        i18n: true,
        fields: { hero_subtitle: { type: 'integer' } },
      } as never, 'user@example.com')

      expect(result.validation.valid).toBe(false)
      expect(result.validation.errors[0]?.message).toContain('still used by 2 entries; changing its type from "text" to "integer"')
      expect(applyPlan).not.toHaveBeenCalled()
    })

    it('refuses a title field that cannot render as a title', async () => {
      const { git, applyPlan } = gitWith({})
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveModel({ id: 'home-page', name: 'Home Page', kind: 'singleton', domain: 'marketing', i18n: true, title_field: 'pricing_preview' } as never, 'user@example.com')

      expect(result.validation.valid).toBe(false)
      expect(result.validation.errors[0]?.field).toBe('title_field')
      expect(applyPlan).not.toHaveBeenCalled()
    })

    it('creates a new model from the payload as sent', async () => {
      const { git, applyPlan } = gitWith({}, {
        readFile: vi.fn(async (path: string) => {
          if (path.endsWith('/config.json')) return JSON.stringify(config)
          throw new Error(`Missing file: ${path}`)
        }),
        listDirectory: vi.fn().mockResolvedValue([]),
      })
      const engine = createContentEngine({ git, contentRoot: '' })

      const result = await engine.saveModel({
        id: 'authors',
        name: 'Authors',
        kind: 'collection',
        domain: 'marketing',
        i18n: true,
        title_field: 'name',
        fields: { name: { type: 'string', required: true } },
      } as never, 'user@example.com', { removeFields: ['name'] })

      expect(result.validation.valid).toBe(true)
      expect(result.modelChange).toMatchObject({ action: 'created', addedFields: ['name'] })
      const call = applyPlan.mock.calls[0]?.[0] as { changes: Array<{ path: string, content: string }> }
      const saved = JSON.parse(call.changes.find(c => c.path.endsWith('/models/authors.json'))!.content)
      // removeFields means nothing for a model that does not exist yet.
      expect(saved.fields.name).toBeDefined()
    })
  })

  it('initializes a project with config, models, content, and meta files', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      applyPlan,
      getBranchDiff: vi.fn().mockResolvedValue([]),
    })
    const engine = createContentEngine({ git, contentRoot: 'apps/web' })

    await engine.initProject(
      'nuxt',
      ['en', 'tr'],
      ['marketing'],
      [
        {
          id: 'faq',
          name: 'FAQ',
          kind: 'collection',
          domain: 'marketing',
          i18n: true,
          fields: {},
        },
      ] as never,
      'user@example.com',
    )

    expect(applyPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: expect.stringMatching(/^cr\/new\/init\//),
        message: expect.stringContaining('contentrain: initialize project'),
        base: 'contentrain',
        changes: expect.arrayContaining([
          expect.objectContaining({ path: 'apps/web/.contentrain/config.json' }),
          expect.objectContaining({ path: 'apps/web/.contentrain/context.json' }),
          expect.objectContaining({ path: 'apps/web/.contentrain/vocabulary.json' }),
          expect.objectContaining({ path: 'apps/web/.contentrain/models/faq.json' }),
          expect.objectContaining({ path: 'apps/web/.contentrain/content/marketing/faq/en.json' }),
          expect.objectContaining({ path: 'apps/web/.contentrain/content/marketing/faq/tr.json' }),
          expect.objectContaining({ path: 'apps/web/.contentrain/meta/faq/en.json' }),
          expect.objectContaining({ path: 'apps/web/.contentrain/meta/faq/tr.json' }),
        ]),
      }),
    )
  })
})

describe('mergeBranch split halves (W4)', () => {
  beforeEach(() => {
    vi.stubGlobal('validateContent', validateContent)
    vi.stubGlobal('errorMessage', (key: string) => key)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mergeToContentrain lands + deletes the branch but never touches main or context.json', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const getDefaultBranch = vi.fn()
    const git = createGitProvider({
      mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'step1-sha', pullRequestUrl: null }),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      getDefaultBranch,
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.mergeToContentrain('cr/content/faq/en/1234567890-abcd')

    expect(result).toEqual({ merged: true, sha: 'step1-sha' })
    expect(git.mergeBranch).toHaveBeenCalledTimes(1)
    expect(git.mergeBranch).toHaveBeenCalledWith('cr/content/faq/en/1234567890-abcd', 'contentrain')
    expect(git.deleteBranch).toHaveBeenCalledWith('cr/content/faq/en/1234567890-abcd')
    expect(getDefaultBranch).not.toHaveBeenCalled()
    expect(applyPlan).not.toHaveBeenCalled()
  })

  it('finalizeContentrain regenerates context once (last branch wins) and advances main', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'main-sha', pullRequestUrl: null }),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.finalizeContentrain([
      'cr/content/faq/en/1111111111-aaaa',
      'cr/content/posts/en/2222222222-bbbb',
    ])

    expect(result).toEqual({ merged: true, sha: 'main-sha', pullRequestUrl: null, mainAdvance: 'advanced' })
    // Exactly one context.json regen commit, derived from the LAST branch.
    const contextCommits = applyPlan.mock.calls.filter(([input]) =>
      (input as { changes: Array<{ path: string }> }).changes.some(c => c.path === '.contentrain/context.json'))
    expect(contextCommits).toHaveLength(1)
    // One step-2 merge to main, no per-branch merges here.
    expect(git.mergeBranch).toHaveBeenCalledTimes(1)
    expect(git.mergeBranch).toHaveBeenCalledWith('contentrain', 'main')
  })

  it('finalizeContentrain falls back to a PR on protected main', async () => {
    const git = createGitProvider({
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      mergeBranch: vi.fn().mockRejectedValue(new Error('protected branch: not allowed')),
      applyPlan: vi.fn().mockResolvedValue(defaultCommit),
      createPR: vi.fn().mockResolvedValue({ id: 'pr-9', url: 'https://example.com/pr/9' }),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.finalizeContentrain(['cr/content/faq/en/1234567890-abcd'])

    // `merged: true` — the content reached contentrain before the advance was
    // ever attempted. The old shape said `merged: false` here, which reported
    // a landed save as a failed one.
    expect(result).toEqual({ merged: true, sha: null, pullRequestUrl: 'https://example.com/pr/9', mainAdvance: 'blocked_diverged' })
    expect(git.createPR).toHaveBeenCalledWith('contentrain', 'main', 'contentrain: advance content to main', 'Auto-generated by Contentrain Studio.')
  })

  it('turns a diverged advance into a PR instead of a thrown 409', async () => {
    // The collabers incident: main carried out-of-Studio .contentrain changes,
    // every contentrain → main merge answered 409, and the route surfaced it
    // as "Server Error" — for a save that had already landed.
    const conflict = Object.assign(new Error('Merge conflict - https://docs.github.com/rest'), { status: 409 })
    const git = createGitProvider({
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      mergeBranch: vi.fn().mockRejectedValue(conflict),
      applyPlan: vi.fn().mockResolvedValue(defaultCommit),
      createPR: vi.fn().mockResolvedValue({ id: 'pr-12', url: 'https://example.com/pr/12' }),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.finalizeContentrain(['cr/content/faq/en/1234567890-abcd'])

    expect(result).toEqual({ merged: true, sha: null, pullRequestUrl: 'https://example.com/pr/12', mainAdvance: 'blocked_diverged' })
    // The PR body names the divergence — it is the artifact a developer
    // resolves, so it has to say what happened.
    const body = (git.createPR as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as string
    expect(body).toContain('diverged')
  })

  it('does not fail the merge when the fallback PR already exists', async () => {
    // Every approve on a diverged repo reaches the PR fallback; GitHub answers
    // 422 for the second one. That is bookkeeping, not a failed merge.
    const conflict = Object.assign(new Error('Merge conflict'), { status: 409 })
    const git = createGitProvider({
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      mergeBranch: vi.fn().mockRejectedValue(conflict),
      applyPlan: vi.fn().mockResolvedValue(defaultCommit),
      createPR: vi.fn().mockRejectedValue(new Error('Validation Failed: A pull request already exists for contentrain.')),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.finalizeContentrain(['cr/content/faq/en/1234567890-abcd'])

    expect(result).toEqual({ merged: true, sha: null, pullRequestUrl: null, mainAdvance: 'blocked_diverged' })
  })

  it('treats a second approve of an already-landed branch as success, not a 500', async () => {
    // Retry chain from the incident: step 1 landed and deleted the cr/*
    // branch, the advance failed, the user clicked Approve again — and the
    // second click died on an unhandled "Head does not exist".
    const git = createGitProvider({
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      mergeBranch: vi.fn().mockImplementation(async (from: string) => {
        if (from.startsWith('cr/')) throw Object.assign(new Error('Head does not exist'), { status: 404 })
        return { merged: true, sha: 'advance-sha', pullRequestUrl: null }
      }),
      applyPlan: vi.fn().mockResolvedValue(defaultCommit),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.mergeBranch('cr/content/faq/en/1234567890-abcd')

    // The content is already on contentrain; the retry finishes the half that
    // actually failed — the advance.
    expect(result).toMatchObject({ merged: true, mainAdvance: 'advanced' })
    expect(git.mergeBranch).toHaveBeenCalledWith('contentrain', 'main')
  })

  it('reports a real cr-vs-contentrain conflict as unmerged, without touching main', async () => {
    const git = createGitProvider({
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      mergeBranch: vi.fn().mockRejectedValue(Object.assign(new Error('Merge conflict'), { status: 409 })),
      applyPlan: vi.fn().mockResolvedValue(defaultCommit),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.mergeBranch('cr/content/faq/en/1234567890-abcd')

    expect(result).toEqual({ merged: false, sha: null, pullRequestUrl: null })
    expect(git.mergeBranch).toHaveBeenCalledTimes(1)
    expect(git.createPR).not.toHaveBeenCalled()
  })

  it('logs — and survives — a diverged main → contentrain sync instead of swallowing it', async () => {
    // The silent catch that made collabers invisible: the sync conflict was
    // eaten under a comment claiming the branches held different directories.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // This test drives a real saveContent, so it needs the path resolvers the
    // rest of this describe's merge-only tests never touch.
    vi.stubGlobal('resolveModelPath', resolveModelPath)
    vi.stubGlobal('resolveContentPath', resolveContentPath)
    vi.stubGlobal('resolveMetaPath', resolveMetaPath)
    vi.stubGlobal('resolveConfigPath', resolveConfigPath)
    vi.stubGlobal('resolveVocabularyPath', resolveVocabularyPath)
    const model = {
      id: 'faq',
      kind: 'collection',
      i18n: true,
      domain: 'marketing',
      title_field: 'question',
      fields: { question: { type: 'string', required: true } },
    }
    const config = { domains: ['marketing'], locales: { default: 'en', supported: ['en'] }, stack: 'astro', version: 1, workflow: 'auto-merge' }
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.includes('/models/faq')) return JSON.stringify(model)
        if (path.endsWith('config.json')) return JSON.stringify(config)
        throw new Error(`not found: ${path}`)
      }),
      mergeBranch: vi.fn().mockImplementation(async (from: string, into: string) => {
        if (into === 'contentrain') throw Object.assign(new Error('Merge conflict'), { status: 409 })
        return { merged: true, sha: 'x', pullRequestUrl: null }
      }),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '', projectId: 'project-x' })

    const result = await engine.saveContent(
      'faq',
      'en',
      { 'faq-1': { question: 'Does a diverged repo block saves?' } },
      'user@example.com',
      { autoPublish: true },
    )

    // The write proceeds — policy (b): the editor is never blocked by a
    // divergence a developer has to resolve.
    expect(result.validation.valid).toBe(true)
    expect(applyPlan).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('diverged'))
    expect(warn.mock.calls[0]?.[0]).toContain('project-x')
    warn.mockRestore()
  })
})
