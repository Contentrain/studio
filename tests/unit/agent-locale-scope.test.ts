import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'
import { createContentEngine } from '../../server/utils/content-engine'
import {
  resolveConfigPath,
  resolveContentPath,
  resolveContextPath,
  resolveMetaPath,
  resolveModelPath,
  resolveModelsDir,
  resolveVocabularyPath,
} from '../../server/utils/content-paths'

/**
 * #284 — an i18n entry is one translation unit: deleting it or changing its
 * status used to touch only the locale the caller happened to address, so
 * "delete this article" left it live in every other locale, and "publish
 * this" only ever published the locale the agent was looking at. Both now
 * default to every configured locale, in one commit; `locales` narrows to a
 * subset, and whatever's left out that still differs is reported back —
 * never silently.
 */

const defaultCommit = { sha: 'c1', message: 'm', author: { name: 'bot', email: 'bot@example.com' }, timestamp: '' }

function createGitProvider(overrides: Partial<GitProvider> = {}): GitProvider {
  return {
    capabilities: { localWorktree: false, sourceRead: false, sourceWrite: false, pushRemote: true, branchProtection: true, pullRequestFallback: true, astScan: false },
    getTree: vi.fn(),
    readFile: vi.fn(),
    listDirectory: vi.fn().mockResolvedValue([]),
    fileExists: vi.fn().mockResolvedValue(false),
    createBranch: vi.fn(),
    listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'sha-1', protected: false }]),
    getBranchDiff: vi.fn().mockResolvedValue([]),
    mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'm', pullRequestUrl: null }),
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

const ARTICLES_MODEL = JSON.stringify({ id: 'articles', name: 'Articles', kind: 'collection', domain: 'blog', i18n: true, fields: {} })
const CONFIG = JSON.stringify({ locales: { supported: ['tr', 'en', 'de'], default: 'tr' } })

function stubPathResolvers() {
  vi.stubGlobal('resolveModelPath', resolveModelPath)
  vi.stubGlobal('resolveContentPath', resolveContentPath)
  vi.stubGlobal('resolveMetaPath', resolveMetaPath)
  vi.stubGlobal('resolveContextPath', resolveContextPath)
  vi.stubGlobal('resolveConfigPath', resolveConfigPath)
  vi.stubGlobal('resolveVocabularyPath', resolveVocabularyPath)
  vi.stubGlobal('resolveModelsDir', resolveModelsDir)
}

describe('engine.deleteContent — locale scope (#284)', () => {
  beforeEach(stubPathResolvers)
  afterEach(() => vi.unstubAllGlobals())

  it('deletes every configured locale by default, in one commit', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/articles.json')) return ARTICLES_MODEL
        if (path.endsWith('/config.json')) return CONFIG
        if (path.endsWith('/blog/articles/tr.json')) return JSON.stringify({ a1: { title: 'Bir' } })
        if (path.endsWith('/blog/articles/en.json')) return JSON.stringify({ a1: { title: 'One' } })
        if (path.endsWith('/blog/articles/de.json')) return JSON.stringify({ a1: { title: 'Eins' } })
        if (path.endsWith('/meta/articles/tr.json') || path.endsWith('/meta/articles/en.json') || path.endsWith('/meta/articles/de.json')) return JSON.stringify({ a1: { status: 'published' } })
        throw new Error(`Unexpected path: ${path}`)
      }),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.deleteContent('articles', 'tr', ['a1'], 'e@x.io')

    expect(result.touchedLocales).toEqual(['de', 'en', 'tr'])
    expect(result.remainingLocales).toBeUndefined()
    const call = applyPlan.mock.calls[0]![0] as { changes: Array<{ path: string }> }
    expect(call.changes.map(c => c.path).filter(p => p.includes('content/blog/articles'))).toEqual([
      '.contentrain/content/blog/articles/de.json',
      '.contentrain/content/blog/articles/en.json',
      '.contentrain/content/blog/articles/tr.json',
    ])
  })

  it('narrows to the given locales and reports which ones still hold the entry', async () => {
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/articles.json')) return ARTICLES_MODEL
        if (path.endsWith('/config.json')) return CONFIG
        if (path.endsWith('/blog/articles/tr.json')) return JSON.stringify({ a1: { title: 'Bir' } })
        if (path.endsWith('/blog/articles/en.json')) return JSON.stringify({ a1: { title: 'One' } })
        // Never existed in de — narrowing away from it must not claim it "remains".
        if (path.endsWith('/blog/articles/de.json')) return JSON.stringify({})
        if (path.endsWith('/meta/articles/tr.json')) return JSON.stringify({ a1: { status: 'published' } })
        throw new Error(`Unexpected path: ${path}`)
      }),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.deleteContent('articles', 'tr', ['a1'], 'e@x.io', ['tr'])

    expect(result.touchedLocales).toEqual(['tr'])
    expect(result.remainingLocales).toEqual(['en'])
  })

  it('refuses an unconfigured locale instead of silently ignoring it', async () => {
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/articles.json')) return ARTICLES_MODEL
        if (path.endsWith('/config.json')) return CONFIG
        throw new Error(`Unexpected path: ${path}`)
      }),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.deleteContent('articles', 'tr', ['a1'], 'e@x.io', ['fr'])

    expect(result.validation.valid).toBe(false)
    expect(result.validation.errors[0]?.message).toContain('fr')
    expect(result.branch).toBe('')
  })

  it('refuses to narrow a document delete instead of silently deleting everything', async () => {
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/guides.json')) return JSON.stringify({ id: 'guides', name: 'Guides', kind: 'document', domain: 'blog', i18n: true, fields: {} })
        if (path.endsWith('/config.json')) return CONFIG
        throw new Error(`Unexpected path: ${path}`)
      }),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.deleteContent('guides', 'tr', ['youtube'], 'e@x.io', ['tr'])

    expect(result.validation.valid).toBe(false)
    expect(result.validation.errors[0]?.message).toContain('not supported')
  })

  it('non-i18n content keeps its single-locale behavior unchanged (#301)', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/faq.json')) return JSON.stringify({ id: 'faq', name: 'FAQ', kind: 'collection', domain: 'marketing', i18n: false, fields: {} })
        if (path.endsWith('/config.json')) return JSON.stringify({ locales: { supported: ['en'], default: 'en' } })
        if (path.endsWith('/marketing/faq/data.json')) return JSON.stringify({ a1: { title: 'One' } })
        if (path.endsWith('/meta/faq/data.json')) return JSON.stringify({ a1: { status: 'published' } })
        throw new Error(`Unexpected path: ${path}`)
      }),
      // Non-i18n content is locale-agnostic (one `data.json`), so MCP forbids
      // a `locale` on it and discovers the file itself from the directory.
      listDirectory: vi.fn().mockResolvedValue(['data.json']),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.deleteContent('faq', 'en', ['a1'], 'e@x.io')

    expect(result.validation.valid).toBe(true)
    expect(result.touchedLocales).toEqual(['en'])
    expect(result.remainingLocales).toBeUndefined()
  })
})

describe('engine.updateEntryStatus — locale scope (#284)', () => {
  beforeEach(stubPathResolvers)
  afterEach(() => vi.unstubAllGlobals())

  it('publishes every configured locale by default, in one commit, and tags each transition with its locale', async () => {
    const applyPlan = vi.fn().mockResolvedValue(defaultCommit)
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/articles.json')) return ARTICLES_MODEL
        if (path.endsWith('/config.json')) return CONFIG
        if (path.endsWith('/meta/articles/tr.json')) return JSON.stringify({ a1: { status: 'draft' } })
        if (path.endsWith('/meta/articles/en.json')) return JSON.stringify({ a1: { status: 'published' } })
        if (path.endsWith('/meta/articles/de.json')) return JSON.stringify({})
        throw new Error(`Unexpected path: ${path}`)
      }),
      applyPlan,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.updateEntryStatus('articles', 'tr', ['a1'], 'published', 'e@x.io')

    expect(result.touchedLocales).toEqual(['de', 'tr'])
    expect(result.statusChanges).toEqual([
      { entryId: 'a1', from: 'draft', to: 'published', locale: 'tr' },
      { entryId: 'a1', from: 'published', to: 'published', locale: 'en' },
      { entryId: 'a1', from: null, to: 'published', locale: 'de' },
    ])
  })

  it('narrows to the given locales and reports which ones still differ', async () => {
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/articles.json')) return ARTICLES_MODEL
        if (path.endsWith('/config.json')) return CONFIG
        if (path.endsWith('/meta/articles/tr.json')) return JSON.stringify({ a1: { status: 'draft' } })
        if (path.endsWith('/meta/articles/en.json')) return JSON.stringify({ a1: { status: 'draft' } })
        // No record in de: nothing to leave behind, must not be reported.
        if (path.endsWith('/meta/articles/de.json')) return JSON.stringify({})
        throw new Error(`Unexpected path: ${path}`)
      }),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.updateEntryStatus('articles', 'tr', ['a1'], 'published', 'e@x.io', ['tr'])

    expect(result.touchedLocales).toEqual(['tr'])
    expect(result.remainingLocales).toEqual(['en'])
  })

  it('keeps the single-locale statusChanges shape when only one locale is in scope', async () => {
    const git = createGitProvider({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/articles.json')) return ARTICLES_MODEL
        if (path.endsWith('/config.json')) return CONFIG
        if (path.endsWith('/meta/articles/tr.json')) return JSON.stringify({ a1: { status: 'draft' } })
        throw new Error(`Unexpected path: ${path}`)
      }),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.updateEntryStatus('articles', 'tr', ['a1'], 'published', 'e@x.io', ['tr'])

    expect(result.statusChanges).toEqual([{ entryId: 'a1', from: 'draft', to: 'published' }])
  })
})

describe('delete_content / update_status tools — locale scope (#284)', () => {
  beforeAll(async () => {
    await import('../../server/utils/conversation-engine')
  }, 60_000)

  const PERMISSIONS: AgentPermissions = { workspaceRole: 'owner', projectRole: null, specificModels: false, allowedModels: [], allowedLocales: [], availableTools: ['delete_content', 'update_status'] }
  const UI: ChatUIContext = { activeModelId: null, activeLocale: 'tr', activeEntryId: null, panelState: 'overview', activeBranch: null }

  function brain(overrides: { allowedLocales?: string[] } = {}) {
    return {
      config: { locales: { supported: ['tr', 'en'], default: 'tr' } },
      models: new Map([['articles', { id: 'articles', kind: 'collection', i18n: true, fields: {} }]]),
      content: new Map(),
      meta: new Map(),
      ...overrides,
    }
  }

  async function run(tool: string, params: Record<string, unknown>, engineOverrides: Record<string, unknown>, permissions = PERMISSIONS) {
    const { emptyAffected } = await import('../../server/utils/agent-types')
    vi.stubGlobal('emptyAffected', emptyAffected)
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
    vi.stubGlobal('agentMessage', vi.fn((key: string, params2?: Record<string, unknown>) => params2?.locales ? `${key}:${params2.locales}` : key))
    vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue(brain()))
    const engine = {
      deleteContent: vi.fn().mockResolvedValue({ branch: 'cr/content/articles/tr/1', commit: { sha: 'c1' }, diff: [], validation: { valid: true, errors: [] }, touchedLocales: ['en', 'tr'] }),
      updateEntryStatus: vi.fn().mockResolvedValue({ branch: 'cr/content/articles/tr/1', commit: { sha: 'c1' }, diff: [], validation: { valid: true, errors: [] }, statusChanges: [], touchedLocales: ['en', 'tr'] }),
      mergeBranch: vi.fn().mockResolvedValue({ merged: true }),
      ...engineOverrides,
    }
    const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
    const out = await executeToolWithAutoMerge(tool, params, engine as never, {} as GitProvider, 'e@x.io', 'u1', 'content', 'auto-merge', permissions, 'pro', 'p1', 'w1', UI)
    return { ...out, engine }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('delete_content defaults to every configured locale when the caller omits `locales`', async () => {
    const { engine } = await run('delete_content', { model: 'articles', entryIds: ['a1'] }, {})
    expect(engine.deleteContent).toHaveBeenCalledWith('articles', 'tr', ['a1'], 'e@x.io', ['tr', 'en'])
  })

  it('delete_content passes an explicit `locales` narrowing straight through', async () => {
    const { engine } = await run('delete_content', { model: 'articles', entryIds: ['a1'], locales: ['en'] }, {})
    expect(engine.deleteContent).toHaveBeenCalledWith('articles', 'tr', ['a1'], 'e@x.io', ['en'])
  })

  it('delete_content refuses a `locales` entry the API key is not allowed to touch', async () => {
    const permissions: AgentPermissions = { ...PERMISSIONS, allowedLocales: ['tr'] }
    const { result, engine } = await run('delete_content', { model: 'articles', entryIds: ['a1'], locales: ['en'] }, {}, permissions)
    expect(engine.deleteContent).not.toHaveBeenCalled()
    expect(result).toMatchObject({ error: expect.stringContaining('en') })
  })

  it('delete_content surfaces a warning when the engine reports locales left behind', async () => {
    const { result } = await run('delete_content', { model: 'articles', entryIds: ['a1'] }, {
      deleteContent: vi.fn().mockResolvedValue({ branch: 'cr/1', commit: { sha: 'c1' }, diff: [{ path: 'x' }], validation: { valid: true, errors: [] }, touchedLocales: ['tr'], remainingLocales: ['en'] }),
    })
    expect(result).toMatchObject({ locales: ['tr'], remainingLocales: ['en'], warning: expect.stringContaining('en') })
  })

  it('update_status defaults to every configured locale when the caller omits `locales`', async () => {
    const { engine } = await run('update_status', { model: 'articles', entryIds: ['a1'], status: 'published' }, {})
    expect(engine.updateEntryStatus).toHaveBeenCalledWith('articles', 'tr', ['a1'], 'published', 'e@x.io', ['tr', 'en'])
  })
})
