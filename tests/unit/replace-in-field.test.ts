import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDefinition } from '@contentrain/types'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'
import { STUDIO_TOOLS } from '../../server/utils/agent-tools'
import { toolRisk, writeSignals } from '../../server/utils/approval-gate'
import { createContentEngine } from '../../server/utils/content-engine'
import { applyTextEdits, replaceExact } from '../../server/utils/content-engine/replace-text'
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
 * #282 — to change one word or link inside a long markdown field the agent
 * re-sent the whole field (3–11K chars). Regenerating long Turkish text
 * dropped `ğ`, merged words, lost an H1 and an intro outside the change, and
 * "N articles fixed" saved fewer than N. replace_in_field sends only the edit.
 */

const LONG_BODY = `# Başlık\n\nGiriş paragrafı: ağaç, dağ, yağmur.\n\n${'Uzun metin satırı, değişmemeli. '.repeat(200)}\n\nDetaylar için [buraya](https://eski.example/yol) bakın. Tekrar: [link](https://eski.example/yol).\n`

describe('replaceExact', () => {
  it('replaces every occurrence by default and counts them', () => {
    expect(replaceExact('a-b-a-b', 'a', 'x')).toEqual({ text: 'x-b-x-b', matches: 2, replaced: 2 })
  })

  it('replaces only the named occurrence', () => {
    expect(replaceExact('a-b-a-b', 'a', 'x', 2)).toEqual({ text: 'a-b-x-b', matches: 2, replaced: 1 })
  })

  it('does not rescan its own replacement', () => {
    expect(replaceExact('aa', 'a', 'aa').text).toBe('aaaa')
  })
})

describe('applyTextEdits', () => {
  const articles = { id: 'articles', kind: 'collection', fields: { title: { type: 'string' }, body: { type: 'markdown' }, author: { type: 'relation', model: 'authors' } } } as unknown as ModelDefinition
  const store: Record<string, Record<string, unknown>> = { a1: { title: 'Yagmur', body: LONG_BODY, author: 'x1' } }
  const current = (entry?: string) => (entry ? store[entry] ?? null : null)

  it('changes only the matched text of a long Turkish body', () => {
    const { changed, errors, replacements } = applyTextEdits(articles, 'tr', [
      { entry: 'a1', field: 'body', find: 'https://eski.example/yol', replace: 'https://yeni.example/yol' },
    ], current)
    expect(errors).toEqual([])
    expect(replacements).toEqual([{ entry: 'a1', field: 'body', replaced: 2 }])
    expect(changed.get('a1')!.body).toBe(LONG_BODY.replaceAll('https://eski.example/yol', 'https://yeni.example/yol'))
  })

  it('chains several edits to one field', () => {
    const { changed } = applyTextEdits(articles, 'tr', [
      { entry: 'a1', field: 'title', find: 'Yagmur', replace: 'Yağmur' },
      { entry: 'a1', field: 'title', find: 'ğ', replace: 'ğğ' },
    ], current)
    expect(changed.get('a1')!.title).toBe('Yağğmur')
  })

  it('refuses a find that matches nothing, and points at a case-only miss', () => {
    const { errors, changed } = applyTextEdits(articles, 'tr', [
      { entry: 'a1', field: 'title', find: 'yagmur', replace: 'Yağmur' },
    ], current)
    expect(changed.size).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('not found')
    expect(errors[0]!.message).toContain('case-sensitive')
  })

  it('refuses an occurrence past the last match, an unknown entry, and a relation field', () => {
    const { errors } = applyTextEdits(articles, 'tr', [
      { entry: 'a1', field: 'body', find: 'https://eski.example/yol', replace: 'x', occurrence: 3 },
      { entry: 'zz', field: 'title', find: 'a', replace: 'b' },
      { entry: 'a1', field: 'author', find: 'x1', replace: 'x2' },
    ], current)
    expect(errors.map(e => e.message)).toEqual([
      expect.stringContaining('occurs 2 times'),
      expect.stringContaining('no entry "zz"'),
      expect.stringContaining('relation field'),
    ])
  })
})

// ── through the engine ──

const commit = { sha: 'c1', message: 'm', author: { name: 'bot', email: 'bot@example.com' }, timestamp: '' }
const config = { version: 1, stack: 'nuxt', workflow: 'auto-merge', domains: ['blog'], locales: { default: 'tr', supported: ['tr'] } }

function gitWith(files: Record<string, unknown>) {
  const reads: Array<{ path: string, ref?: string }> = []
  const git = {
    readFile: vi.fn(async (path: string, ref?: string) => {
      reads.push({ path, ref })
      for (const [suffix, value] of Object.entries(files)) {
        if (path.endsWith(suffix)) return typeof value === 'string' ? value : JSON.stringify(value)
      }
      throw Object.assign(new Error(`not found: ${path}`), { status: 404 })
    }),
    listDirectory: vi.fn().mockResolvedValue([]),
    fileExists: vi.fn().mockResolvedValue(false),
    listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'head1', protected: false }]),
    getBranchSha: vi.fn().mockResolvedValue('head1'),
    createBranchAt: vi.fn().mockResolvedValue(undefined),
    mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'm', pullRequestUrl: null }),
    getBranchDiff: vi.fn().mockResolvedValue([]),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    applyPlan: vi.fn().mockResolvedValue(commit),
  }
  return { git: git as unknown as GitProvider & typeof git, reads }
}

function written(git: { applyPlan: ReturnType<typeof vi.fn> }, suffix: string): string {
  const changes = git.applyPlan.mock.calls[0]![0].changes as Array<{ path: string, content: string }>
  return changes.find(c => c.path.endsWith(suffix))!.content
}

describe('engine.replaceText', () => {
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

  const articles = { id: 'articles', name: 'Articles', kind: 'collection', domain: 'blog', i18n: true, fields: { title: { type: 'string', required: true }, body: { type: 'markdown' } } }
  const guides = { id: 'guides', name: 'Guides', kind: 'document', domain: 'blog', i18n: true, fields: { title: { type: 'string', required: true } } }

  it('writes the field with only the match changed, forked from the commit it read', async () => {
    const { git, reads } = gitWith({
      'models/articles.json': articles,
      'config.json': config,
      'content/blog/articles/tr.json': { a1: { title: 'Başlık', body: LONG_BODY }, a2: { title: 'Diğer', body: 'dokunma' } },
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.replaceText('articles', 'tr', [
      { entry: 'a1', field: 'body', find: 'https://eski.example/yol', replace: 'https://yeni.example/yol', occurrence: 1 },
    ], 'e@x.io')

    expect(result.validation.valid).toBe(true)
    expect(result.replacements).toEqual([{ entry: 'a1', field: 'body', replaced: 1 }])
    const file = JSON.parse(written(git, 'content/blog/articles/tr.json'))
    expect(file.a1.body).toBe(LONG_BODY.replace('https://eski.example/yol', 'https://yeni.example/yol'))
    expect(file.a2).toEqual({ title: 'Diğer', body: 'dokunma' })
    // One snapshot: the content was read at head1, and the branch forks there.
    expect(reads.filter(r => r.path.endsWith('articles/tr.json')).every(r => r.ref === 'head1')).toBe(true)
    expect(git.getBranchSha).toHaveBeenCalledTimes(1)
    expect(git.createBranchAt).toHaveBeenCalledWith(expect.any(String), 'head1')
  })

  it('writes nothing when one edit of a batch does not match', async () => {
    const { git } = gitWith({
      'models/articles.json': articles,
      'config.json': config,
      'content/blog/articles/tr.json': { a1: { title: 'Başlık', body: LONG_BODY }, a2: { title: 'Diğer', body: 'metin' } },
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.replaceText('articles', 'tr', [
      { entry: 'a1', field: 'title', find: 'Başlık', replace: 'Yeni başlık' },
      { entry: 'a2', field: 'body', find: 'yok böyle bir metin', replace: 'x' },
    ], 'e@x.io')

    expect(result.validation.valid).toBe(false)
    expect(result.validation.errors).toEqual([expect.objectContaining({ entry: 'a2', field: 'body' })])
    expect(git.applyPlan).not.toHaveBeenCalled()
  })

  it('edits a document body and keeps its frontmatter', async () => {
    const { git } = gitWith({
      'models/guides.json': guides,
      'config.json': config,
      'content/blog/guides/youtube/tr.md': `---\ntitle: YouTube Rehberi\n---\n${LONG_BODY}`,
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.replaceText('guides', 'tr', [
      { entry: 'YouTube', field: 'body', find: 'Giriş paragrafı', replace: 'Giriş bölümü' },
    ], 'e@x.io')

    expect(result.validation.valid).toBe(true)
    const markdown = written(git, 'content/blog/guides/youtube/tr.md')
    expect(markdown).toContain('title: YouTube Rehberi')
    expect(markdown).toContain('# Başlık')
    expect(markdown).toContain('Giriş bölümü: ağaç, dağ, yağmur.')
    expect(markdown).not.toContain('Giriş paragrafı')
  })
})

// ── the tool ──

describe('replace_in_field tool', () => {
  beforeAll(async () => {
    await import('../../server/utils/conversation-engine')
  }, 60_000)

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  const PERMISSIONS: AgentPermissions = { workspaceRole: 'owner', projectRole: null, specificModels: false, allowedModels: [], allowedLocales: [], availableTools: ['replace_in_field'] }
  const UI: ChatUIContext = { activeModelId: null, activeLocale: 'tr', activeEntryId: null, panelState: 'overview', activeBranch: null }

  async function run(replaceText: ReturnType<typeof vi.fn>, params: Record<string, unknown>) {
    const { emptyAffected } = await import('../../server/utils/agent-types')
    vi.stubGlobal('emptyAffected', emptyAffected)
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
    vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { locales: { default: 'tr' } }, content: new Map(), meta: new Map(), models: new Map() }))
    const engine = { replaceText, mergeBranch: vi.fn().mockResolvedValue({ merged: true }) }
    const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
    return executeToolWithAutoMerge('replace_in_field', params, engine as never, {} as GitProvider, 'e@x.io', 'u1', 'content', 'auto-merge', PERMISSIONS, 'pro', 'p1', 'w1', UI)
  }

  it('is a classified content write whose schema requires the edits', () => {
    const tool = STUDIO_TOOLS.find(t => t.name === 'replace_in_field')!
    expect((tool.inputSchema as { required: string[] }).required).toEqual(['model', 'edits'])
    expect(toolRisk('replace_in_field', { entries: ['a1'] }, writeSignals('replace_in_field', { edits: [{ replace: 'x' }] }))).toBe('low_risk_content')
    expect(toolRisk('replace_in_field', { entries: ['a1', 'a2'] })).toBe('bulk_content')
  })

  it('reports a find that matched nothing as an error, not a fix', async () => {
    const replaceText = vi.fn().mockResolvedValue({
      branch: '',
      commit: { sha: '' },
      diff: [],
      validation: { valid: false, errors: [{ entry: 'a1', field: 'body', locale: 'tr', message: '`find` text not found', severity: 'error' }] },
    })
    const { result } = await run(replaceText, { model: 'articles', edits: [{ entry: 'a1', field: 'body', find: 'x', replace: 'y' }] })
    expect(result).toEqual({ error: expect.stringContaining('`find` text not found') })
  })

  it('writes in the user\'s locale and returns the replacement counts', async () => {
    const replaceText = vi.fn().mockResolvedValue({
      branch: 'cr/content/articles/tr/1',
      commit: { sha: 'c1' },
      diff: [],
      validation: { valid: true, errors: [] },
      replacements: [{ entry: 'a1', field: 'body', replaced: 2 }],
    })
    const { result } = await run(replaceText, { model: 'articles', edits: [{ entry: 'a1', field: 'body', find: 'x', replace: 'y' }] })
    expect(replaceText.mock.calls[0]![1]).toBe('tr')
    expect(result).toMatchObject({ merged: true, replacements: [{ entry: 'a1', field: 'body', replaced: 2 }] })
  })
})
