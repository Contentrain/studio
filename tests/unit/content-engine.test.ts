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
