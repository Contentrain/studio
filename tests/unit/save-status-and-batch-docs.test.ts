import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalPolicyFile } from '@contentrain/types'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'
import { decideMerge, savedEntryIds, writeSignals } from '../../server/utils/approval-gate'
import { createContentEngine } from '../../server/utils/content-engine'
import { validateContent } from '../../server/utils/content-validation'
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
 * #297 — a save reported only `merged: true`; new entries were drafts, the
 * agent said "published", and the editor couldn't find them. Publishing took a
 * second update_status turn per entry.
 *
 * #292 — rewriting a guide's sections was one save per section, each with its
 * own branch and merge: five to six minutes for 10–13 sections.
 */

/** A project that trusts content edits and nothing else. */
const AUTO_CONTENT: ApprovalPolicyFile = {
  version: 1,
  rules: [
    { risk: 'low_risk_content', gate: 'change', mode: 'auto' },
    { risk: 'bulk_content', gate: 'change', mode: 'single' },
  ],
}

describe('approval gate sees a save that publishes (#297)', () => {
  it('reads the target status of a save_content that sets one', () => {
    expect(writeSignals('save_content', { mode: 'update', status: 'published', data: { a: { title: 'x' } } }))
      .toMatchObject({ targetStatus: 'published', textChars: 1 })
    expect(writeSignals('save_content', { mode: 'update', data: { a: { title: 'x' } } }))
      .not.toHaveProperty('targetStatus')
  })

  it('holds "save and publish" under a policy that lets the same save through', async () => {
    const scope = { entries: ['a'] }
    const plain = await decideMerge({ workflow: 'review', tool: 'save_content', scope, signals: writeSignals('save_content', { data: { a: { title: 'x' } } }), policy: AUTO_CONTENT })
    expect(plain.allowed).toBe(true)

    const publishing = await decideMerge({ workflow: 'review', tool: 'save_content', scope, signals: writeSignals('save_content', { status: 'published', data: { a: { title: 'x' } } }), policy: AUTO_CONTENT })
    expect(publishing.allowed).toBe(false)
    expect(publishing.review.approval?.reasons[0]).toContain('moves content to `published`')
  })

  it('counts every document of a batch, and names every slug', () => {
    const params = { mode: 'update', documents: [{ slug: 'one', data: { title: 'A' }, body: 'x'.repeat(10) }, { slug: 'two', data: { title: '' } }] }
    expect(writeSignals('save_content', params)).toEqual({ emptiedFields: 1, textChars: 11 })
    expect(savedEntryIds(params)).toEqual(['one', 'two'])
  })
})

// ── the whole tool path, review workflow ──

const PERMISSIONS: AgentPermissions = {
  workspaceRole: 'owner',
  projectRole: null,
  specificModels: false,
  allowedModels: [],
  allowedLocales: [],
  availableTools: ['save_content'],
}
const UI: ChatUIContext = { activeModelId: null, activeLocale: 'tr', activeEntryId: null, panelState: 'overview', activeBranch: null }

async function runSaveInReview(params: Record<string, unknown>) {
  const { emptyAffected } = await import('../../server/utils/agent-types')
  vi.stubGlobal('emptyAffected', emptyAffected)
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('invalidateBrainCache', vi.fn())
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
    config: { locales: { default: 'tr' } },
    content: new Map(),
    meta: new Map(),
    models: new Map([['articles', { id: 'articles', kind: 'collection' }]]),
    approvalPolicy: AUTO_CONTENT,
  }))
  const engine = {
    saveContent: vi.fn().mockResolvedValue({
      branch: 'cr/content/articles/tr/1',
      commit: { sha: 'c1' },
      diff: [],
      validation: { valid: true, errors: [] },
      statuses: { a: params.status ?? 'draft' },
    }),
    mergeBranch: vi.fn().mockResolvedValue({ merged: true, branch: 'cr/content/articles/tr/1' }),
  }
  const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
  const out = await executeToolWithAutoMerge(
    'save_content', params, engine as never, {} as GitProvider, 'e@x.io', 'u1', 'content', 'review', PERMISSIONS, 'pro', 'p1', 'w1', UI,
  )
  return { ...out, engine }
}

describe('save_content with status in a review workflow (#297)', () => {
  beforeAll(async () => {
    await import('../../server/utils/conversation-engine')
  }, 60_000)

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('merges a plain edit the policy trusts', async () => {
    const { result, engine } = await runSaveInReview({ model: 'articles', locale: 'tr', mode: 'update', data: { a: { title: 'x' } } })
    expect(engine.mergeBranch).toHaveBeenCalled()
    expect(result).toMatchObject({ merged: true, statuses: { a: 'draft' } })
  })

  it('holds the same edit for review when it also publishes — the gate is not bypassed', async () => {
    const { result, engine } = await runSaveInReview({ model: 'articles', locale: 'tr', mode: 'update', status: 'published', data: { a: { title: 'x' } } })
    expect(engine.saveContent.mock.calls[0]![4]).toMatchObject({ status: 'published' })
    expect(engine.mergeBranch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ merged: false, reviewBranch: 'cr/content/articles/tr/1' })
  })
})

// ── through the engine ──

const commit = { sha: 'c1', message: 'm', author: { name: 'bot', email: 'bot@example.com' }, timestamp: '' }
const config = { version: 1, stack: 'nuxt', workflow: 'auto-merge', domains: ['blog'], locales: { default: 'tr', supported: ['tr'] } }
const articles = { id: 'articles', name: 'Articles', kind: 'collection', domain: 'blog', i18n: true, fields: { title: { type: 'string', required: true } } }
const guides = { id: 'guides', name: 'Guides', kind: 'document', domain: 'blog', i18n: true, fields: { title: { type: 'string', required: true } } }

function gitWith(files: Record<string, unknown>) {
  const git = {
    readFile: vi.fn(async (path: string) => {
      for (const [suffix, value] of Object.entries(files)) {
        if (path.endsWith(suffix)) return typeof value === 'string' ? value : JSON.stringify(value)
      }
      throw Object.assign(new Error(`not found: ${path}`), { status: 404 })
    }),
    listDirectory: vi.fn().mockResolvedValue([]),
    fileExists: vi.fn().mockResolvedValue(false),
    listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'abc', protected: false }]),
    mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'm', pullRequestUrl: null }),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    getBranchDiff: vi.fn().mockResolvedValue([]),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    applyPlan: vi.fn().mockResolvedValue(commit),
  }
  return git as unknown as GitProvider & typeof git
}

function writtenJson(git: { applyPlan: ReturnType<typeof vi.fn> }, suffix: string, call = 0): Record<string, { status?: string }> {
  const changes = git.applyPlan.mock.calls[call]![0].changes as Array<{ path: string, content: string }>
  return JSON.parse(changes.find(c => c.path.endsWith(suffix))!.content)
}

describe('engine: status in the save commit, and batch documents', () => {
  beforeEach(() => {
    vi.stubGlobal('resolveModelPath', resolveModelPath)
    vi.stubGlobal('resolveContentPath', resolveContentPath)
    vi.stubGlobal('resolveMetaPath', resolveMetaPath)
    vi.stubGlobal('resolveContextPath', resolveContextPath)
    vi.stubGlobal('resolveConfigPath', resolveConfigPath)
    vi.stubGlobal('resolveVocabularyPath', resolveVocabularyPath)
    vi.stubGlobal('resolveModelsDir', resolveModelsDir)
    vi.stubGlobal('validateContent', validateContent)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates and publishes in one commit, and reports the status it wrote', async () => {
    const git = gitWith({ 'models/articles.json': articles, 'config.json': config, 'content/blog/articles/tr.json': {} })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.saveContent('articles', 'tr', { n1: { title: 'Yeni' } }, 'e@x.io', { mode: 'create', status: 'published' })

    expect(writtenJson(git, 'meta/articles/tr.json').n1!.status).toBe('published')
    expect(result.statuses).toEqual({ n1: 'published' })
  })

  it('reports a new entry as draft when no status is asked for', async () => {
    const git = gitWith({ 'models/articles.json': articles, 'config.json': config, 'content/blog/articles/tr.json': {} })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.saveContent('articles', 'tr', { n1: { title: 'Yeni' } }, 'e@x.io', { mode: 'create' })

    expect(result.statuses).toEqual({ n1: 'draft' })
  })

  it('writes several documents in one commit and one branch', async () => {
    const git = gitWith({ 'models/guides.json': guides, 'config.json': config })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.saveDocuments('guides', 'tr', [
      { slug: 'one', frontmatter: { title: 'Bir' }, body: 'Birinci' },
      { slug: 'two', frontmatter: { title: 'İki' }, body: 'İkinci' },
      { slug: 'three', frontmatter: { title: 'Üç' }, body: 'Üçüncü' },
    ], 'e@x.io', { mode: 'create', status: 'published' })

    expect(result.validation.valid).toBe(true)
    expect(git.applyPlan).toHaveBeenCalledTimes(1)
    const paths = (git.applyPlan.mock.calls[0]![0].changes as Array<{ path: string }>).map(c => c.path)
    for (const slug of ['one', 'two', 'three']) expect(paths.some(p => p.includes(`/${slug}/`))).toBe(true)
    expect(result.entries).toEqual({ created: ['one', 'two', 'three'], updated: [] })
    expect(result.statuses).toEqual({ one: 'published', two: 'published', three: 'published' })
  })

  it('writes none of a batch when one document is invalid, and names it', async () => {
    const git = gitWith({ 'models/guides.json': guides, 'config.json': config, 'content/blog/guides/two/tr.md': '---\ntitle: Var\n---\nGövde\n' })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.saveDocuments('guides', 'tr', [
      { slug: 'one', frontmatter: { title: 'Bir' }, body: 'Birinci' },
      { slug: 'two', frontmatter: { title: 'Yeniden' }, body: 'Başka' },
    ], 'e@x.io', { mode: 'create' })

    expect(result.validation.valid).toBe(false)
    expect(result.validation.errors).toEqual([expect.objectContaining({ entry: 'two' })])
    expect(git.applyPlan).not.toHaveBeenCalled()
  })

  it('refuses a batch over the limit, or one naming a slug twice', async () => {
    const git = gitWith({ 'models/guides.json': guides, 'config.json': config })
    const engine = createContentEngine({ git, contentRoot: '' })
    const doc = (slug: string) => ({ slug, frontmatter: { title: 'T' }, body: 'B' })

    const tooMany = await engine.saveDocuments('guides', 'tr', Array.from({ length: 21 }, (_, i) => doc(`s${i}`)), 'e@x.io')
    const duplicate = await engine.saveDocuments('guides', 'tr', [doc('same'), doc('same')], 'e@x.io')

    expect(tooMany.validation.valid).toBe(false)
    expect(duplicate.validation.valid).toBe(false)
    expect(git.applyPlan).not.toHaveBeenCalled()
  })

  it('redoes a conflicting batch as a whole, once', async () => {
    const git = gitWith({ 'models/guides.json': guides, 'config.json': config })
    const engine = createContentEngine({ git, contentRoot: '' })
    const write = await engine.saveDocuments('guides', 'tr', [
      { slug: 'one', frontmatter: { title: 'Bir' }, body: 'Birinci' },
      { slug: 'two', frontmatter: { title: 'İki' }, body: 'İkinci' },
    ], 'e@x.io')
    git.mergeBranch.mockRejectedValue(Object.assign(new Error('Merge conflict'), { status: 409 }))
    git.mergeBranch.mockClear()
    git.applyPlan.mockClear()

    const landed = await engine.mergeToContentrain(write.branch)

    expect(landed).toMatchObject({ merged: false, conflict: true, redone: true })
    expect(git.applyPlan).toHaveBeenCalledTimes(1)
    // The redo rewrites the whole batch: both documents' content and meta.
    expect((git.applyPlan.mock.calls[0]![0].changes as unknown[]).length).toBe(4)
  })
})
