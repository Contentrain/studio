import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'

/**
 * Publish status must be reachable by READING.
 *
 * Incident (staging, 2026-08-25): asked whether three articles were draft or
 * published, the agent tried brain_query, get_content, brain_search and
 * relation_expand, found `status` in none of them, and finally ran
 * `update_status` as a probe — publishing three deliberately-drafted articles
 * onto the live site, then reporting they had "already been published".
 *
 * Two read defects made that the only move it had left:
 *   - the entryId-scoped brain_query dropped `meta` entirely, and that is the
 *     exact path the truncation notice sends the caller to;
 *   - `meta` was serialised AFTER `data`, so on any model large enough to hit
 *     the 32k tool-result cap it was the first thing truncated away.
 */

const PERMISSIONS: AgentPermissions = {
  workspaceRole: 'owner',
  projectRole: null,
  specificModels: false,
  allowedModels: [],
  allowedLocales: [],
  availableTools: ['brain_query', 'get_content', 'brain_search', 'update_status'],
}

const UI_CONTEXT: ChatUIContext = {
  activeModelId: null,
  activeLocale: 'en',
  activeEntryId: null,
  panelState: 'overview',
  activeBranch: null,
}

function stubBrain(brain: {
  content: Map<string, unknown>
  meta: Map<string, Record<string, unknown>>
  models: Map<string, { id: string, kind: string }>
}) {
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue(brain))
}

async function runTool(toolName: string, params: Record<string, unknown>, engine: unknown = {}) {
  const { emptyAffected } = await import('../../server/utils/agent-types')
  vi.stubGlobal('emptyAffected', emptyAffected)
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))

  const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
  return executeToolWithAutoMerge(
    toolName,
    params,
    engine as never,
    {} as GitProvider,
    'owner@example.com',
    'user-1',
    'content',
    'auto-merge',
    PERMISSIONS,
    'pro',
    'project-1',
    'workspace-1',
    UI_CONTEXT,
  )
}

/** articles-shaped fixture: two entries, one published, one draft. */
function articlesBrain() {
  return {
    content: new Map<string, unknown>([
      ['articles:tr', {
        f3a81c09d24e: { title: 'Creator Economy' },
        c5e07a3b961d: { title: 'TikTok Creator Rewards' },
      }],
    ]),
    meta: new Map<string, Record<string, unknown>>([
      ['articles:tr', {
        f3a81c09d24e: { status: 'draft', source: 'agent' },
        c5e07a3b961d: { status: 'published', source: 'agent' },
      }],
    ]),
    models: new Map([['articles', { id: 'articles', kind: 'collection' }]]),
  }
}

describe('publish status is readable without writing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('brain_query returns the entry meta when scoped to a single entryId', async () => {
    stubBrain(articlesBrain())

    const { result } = await runTool('brain_query', { model: 'articles', locale: 'tr', entryId: 'f3a81c09d24e' })

    expect(result).toMatchObject({
      entryId: 'f3a81c09d24e',
      meta: { status: 'draft' },
      data: { title: 'Creator Economy' },
    })
  })

  it('brain_query narrows meta to the requested entry, not the whole model', async () => {
    stubBrain(articlesBrain())

    const { result } = await runTool('brain_query', { model: 'articles', locale: 'tr', entryId: 'c5e07a3b961d' })

    expect((result as { meta: unknown }).meta).toEqual({ status: 'published', source: 'agent' })
  })

  it('brain_query on a singleton returns the model-level meta for any entryId', async () => {
    stubBrain({
      content: new Map<string, unknown>([['settings:en', { site_title: 'Collabers' }]]),
      meta: new Map<string, Record<string, unknown>>([['settings:en', { status: 'published' }]]),
      models: new Map([['settings', { id: 'settings', kind: 'singleton' }]]),
    })

    // A singleton's content is a flat field map, so the entryId branch only
    // fires when the caller passes one; either way status must be reachable.
    const { result } = await runTool('brain_query', { model: 'settings', locale: 'en' })

    expect((result as { meta: unknown }).meta).toEqual({ status: 'published' })
  })

  it('serialises meta before data so truncation cannot eat the status', async () => {
    stubBrain(articlesBrain())

    for (const tool of ['brain_query', 'get_content']) {
      const { result } = await runTool(tool, { model: 'articles', locale: 'tr' })
      const keys = Object.keys(result as Record<string, unknown>)
      expect(keys.indexOf('meta'), `${tool} must put meta before data`).toBeLessThan(keys.indexOf('data'))
    }
  })

  it('brain_search reports each hit\'s publish status', async () => {
    stubBrain(articlesBrain())
    const search = await import('../../server/utils/brain-search')
    vi.stubGlobal('collectSearchableText', search.collectSearchableText)
    vi.stubGlobal('tokenizeQuery', search.tokenizeQuery)
    vi.stubGlobal('scoreEntryText', search.scoreEntryText)
    vi.stubGlobal('BRAIN_SEARCH_MIN_SCORE', search.BRAIN_SEARCH_MIN_SCORE)

    const { result } = await runTool('brain_search', { model: 'articles', query: 'Creator' })

    const results = (result as { results: Array<{ entryId: string, status: string | null }> }).results
    expect(results.length).toBeGreaterThan(0)
    expect(results.find(r => r.entryId === 'f3a81c09d24e')?.status).toBe('draft')
  })

  it('reports status as null when an entry has no meta record', async () => {
    stubBrain({
      content: new Map<string, unknown>([['articles:tr', { orphan: { title: 'No meta' } }]]),
      meta: new Map<string, Record<string, unknown>>(),
      models: new Map([['articles', { id: 'articles', kind: 'collection' }]]),
    })

    const { result } = await runTool('brain_query', { model: 'articles', locale: 'tr', entryId: 'orphan' })

    expect((result as { meta: unknown }).meta).toBeNull()
  })
})

describe('update_status tells the caller what it changed', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  function statusEngine(writeResult: Record<string, unknown>) {
    return {
      updateEntryStatus: vi.fn().mockResolvedValue({
        branch: 'cr/content/articles/tr/1',
        commit: { sha: 'abc' },
        diff: [{}],
        validation: { valid: true, errors: [] },
        ...writeResult,
      }),
      mergeBranch: vi.fn().mockResolvedValue({ merged: true }),
      mergeToContentrain: vi.fn().mockResolvedValue({ merged: true }),
    }
  }

  it('surfaces the from → to transition on the tool result', async () => {
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    const engine = statusEngine({
      statusChanges: [{ entryId: 'f3a81c09d24e', from: 'draft', to: 'published' }],
    })

    const { result } = await runTool(
      'update_status',
      { model: 'articles', locale: 'tr', entryIds: ['f3a81c09d24e'], status: 'published' },
      engine,
    )

    expect((result as { statusChanges: unknown }).statusChanges).toEqual([
      { entryId: 'f3a81c09d24e', from: 'draft', to: 'published' },
    ])
  })

  it('does not merge or drop the brain cache when nothing was written', async () => {
    const invalidate = vi.fn()
    vi.stubGlobal('invalidateBrainCache', invalidate)
    const engine = statusEngine({
      branch: '',
      commit: { sha: '' },
      diff: [],
      unchanged: true,
      statusChanges: [{ entryId: 'f3a81c09d24e', from: 'published', to: 'published' }],
    })

    const { result, affected } = await runTool(
      'update_status',
      { model: 'articles', locale: 'tr', entryIds: ['f3a81c09d24e'], status: 'published' },
      engine,
    )

    expect(result).toMatchObject({ unchanged: true, merged: false })
    expect(engine.mergeBranch).not.toHaveBeenCalled()
    expect(engine.mergeToContentrain).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
    expect(affected.branchesChanged).toBe(false)
  })
})
