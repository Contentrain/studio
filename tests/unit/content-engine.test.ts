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
    expect(result).toEqual({
      merged: false,
      sha: null,
      pullRequestUrl: 'https://example.com/pr/1',
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

    expect(result).toEqual({ merged: true, sha: 'main-sha', pullRequestUrl: null })
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

    expect(result).toEqual({ merged: false, sha: null, pullRequestUrl: 'https://example.com/pr/9' })
    expect(git.createPR).toHaveBeenCalledWith('contentrain', 'main', 'contentrain: advance content to main', 'Auto-generated by Contentrain Studio.')
  })
})
