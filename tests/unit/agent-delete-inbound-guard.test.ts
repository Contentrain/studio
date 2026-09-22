import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FieldDef } from '@contentrain/types'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'
import type { ExpandModelView } from '../../server/utils/relation-expand'
import { findInboundEntryRefs } from '../../server/utils/relation-expand'

/**
 * #293 — deleting an entry other entries still pointed at left dangling
 * relations; a later save of the referencing list then failed on a target
 * that no longer existed, and the agent needed eight reads to find it.
 * (The issue also claimed the relation validator lists only the first
 * missing target — it doesn't; `findBrokenRelations` collects them all.)
 */

const reportAgentToolError = vi.fn()
vi.mock('../../server/utils/alert', () => ({
  reportAgentToolError: (...args: unknown[]) => reportAgentToolError(...args),
}))

const ARTICLE_FIELDS: Record<string, FieldDef> = { title: { type: 'string' }, related: { type: 'relations', model: 'articles' } as FieldDef }
const SLIDE_FIELDS: Record<string, FieldDef> = { title: { type: 'string' }, article: { type: 'relation', model: 'articles' } as FieldDef }
const SETTINGS_FIELDS: Record<string, FieldDef> = { ticker: { type: 'relations', model: 'articles' } as FieldDef, promo: { type: 'relation', model: ['articles', 'pages'] } as FieldDef }

function view(modelId: string, fields: Record<string, FieldDef>, entries: Record<string, Record<string, unknown>>): ExpandModelView {
  return { modelId, fields, entries: new Map(Object.entries(entries)) }
}

const VIEWS: ExpandModelView[] = [
  view('articles', ARTICLE_FIELDS, { a1: { title: 'One' }, a2: { title: 'Two', related: ['a1'] }, a3: { title: 'Three', related: ['a2'] } }),
  view('hero-slides', SLIDE_FIELDS, { s1: { title: 'Slide', article: 'a1' } }),
  // Same entry in a second locale — must not be listed twice.
  view('hero-slides', SLIDE_FIELDS, { s1: { title: 'Slide EN', article: 'a1' } }),
  view('settings', SETTINGS_FIELDS, { settings: { ticker: ['a1', 'a3'], promo: { model: 'articles', ref: 'a1' } } }),
]

describe('findInboundEntryRefs', () => {
  it('lists every entry that references the target, not just the first', () => {
    const refs = findInboundEntryRefs('articles', ['a1'], VIEWS)
    expect(refs.map(r => `${r.model}.${r.ref}.${r.field}`).sort()).toEqual([
      'articles.a2.related',
      'hero-slides.s1.article',
      'settings.settings.promo',
      'settings.settings.ticker',
    ])
  })

  it('ignores references among entries deleted together', () => {
    const refs = findInboundEntryRefs('articles', ['a2', 'a3'], VIEWS)
    // a3 → a2 goes with them; nothing else points at a2 or a3 except the ticker.
    expect(refs.map(r => `${r.model}.${r.ref}.${r.field}→${r.target}`)).toEqual(['settings.settings.ticker→a3'])
  })

  it('returns nothing for an unreferenced entry', () => {
    expect(findInboundEntryRefs('articles', ['zz'], VIEWS)).toEqual([])
  })
})

const PERMISSIONS: AgentPermissions = {
  workspaceRole: 'owner',
  projectRole: null,
  specificModels: false,
  allowedModels: [],
  allowedLocales: [],
  availableTools: ['delete_content'],
}
const UI: ChatUIContext = { activeModelId: null, activeLocale: 'tr', activeEntryId: null, panelState: 'overview', activeBranch: null }
const IN_USE = 'This entry is still referenced by other content, so it was not deleted. Change or clear these references first, or ask the user how to proceed'

function brain(models: string[]) {
  return {
    config: { locales: { default: 'tr' } },
    models: new Map(models.map(id => [id, {
      id,
      kind: id === 'settings' ? 'singleton' : 'collection',
      fields: id === 'articles' ? ARTICLE_FIELDS : id === 'hero-slides' ? SLIDE_FIELDS : SETTINGS_FIELDS,
    }])),
    content: new Map<string, unknown>([
      ['articles:tr', { a1: { title: 'Bir' }, a2: { title: 'İki', related: ['a1'] }, a9: { title: 'Yalnız' } }],
      ['hero-slides:tr', { s1: { title: 'Slayt', article: 'a1' } }],
    ]),
    meta: new Map(),
  }
}

async function runDelete(entryIds: string[], brainModels = ['articles', 'hero-slides']) {
  const { emptyAffected } = await import('../../server/utils/agent-types')
  vi.stubGlobal('emptyAffected', emptyAffected)
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  vi.stubGlobal('errorMessage', vi.fn((key: string) => key === 'content.entry_in_use' ? IN_USE : key))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('invalidateBrainCache', vi.fn())
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue(brain(brainModels)))
  const engine = {
    deleteContent: vi.fn().mockResolvedValue({ branch: 'cr/content/articles/tr/1', commit: { sha: 'c1' }, diff: [], validation: { valid: true, errors: [] } }),
    mergeBranch: vi.fn().mockResolvedValue({ merged: true }),
  }
  const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
  const out = await executeToolWithAutoMerge(
    'delete_content', { model: 'articles', locale: 'tr', entryIds }, engine as never, {} as GitProvider, 'e@x.io', 'u1', 'content', 'auto-merge', PERMISSIONS, 'pro', 'p1', 'w1', UI,
  )
  return { ...out, engine }
}

describe('delete_content refuses to orphan references (#293)', () => {
  beforeAll(async () => {
    await import('../../server/utils/conversation-engine')
  }, 60_000)

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
    reportAgentToolError.mockClear()
  })

  it('refuses a referenced entry, writes nothing and lists every referrer', async () => {
    const { result, engine } = await runDelete(['a1'])

    expect(engine.deleteContent).not.toHaveBeenCalled()
    const { error, referencedBy } = result as { error: string, referencedBy: Array<{ model: string, ref: string }> }
    expect(error.startsWith(`${IN_USE}: `)).toBe(true)
    expect(error).toContain('articles.a2 (related')
    expect(error).toContain('hero-slides.s1 (article')
    expect(referencedBy.map(r => `${r.model}.${r.ref}`).sort()).toEqual(['articles.a2', 'hero-slides.s1'])
  })

  it('reports only the fixed label to monitoring — the list can carry editor text', async () => {
    await runDelete(['a1'])

    // The cause code is the fixed label (capped by errorResultClass), the same
    // for every blocked delete — never the referencing entries or their titles.
    const context = reportAgentToolError.mock.calls[0]![1] as { errorClass: string }
    expect(IN_USE.startsWith(context.errorClass)).toBe(true)
    expect(context.errorClass).not.toMatch(/a2|s1|Slayt|İki/)
  })

  it('deletes an unreferenced entry', async () => {
    const { result, engine } = await runDelete(['a9'])

    // 5th arg is the #284 locale scope — undefined here since this fixture's
    // "articles" model doesn't declare i18n.
    expect(engine.deleteContent).toHaveBeenCalledWith('articles', 'tr', ['a9'], 'e@x.io', undefined)
    expect(result).not.toHaveProperty('referencesChecked')
  })

  it('says so when references could not be checked, instead of skipping silently', async () => {
    const { result, engine } = await runDelete(['a1'], ['hero-slides'])

    expect(engine.deleteContent).toHaveBeenCalled()
    expect(result).toMatchObject({ referencesChecked: false })
  })
})
