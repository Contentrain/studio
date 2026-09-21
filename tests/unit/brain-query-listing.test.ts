import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'

/**
 * brain_query could not filter, project or sort, collection reads truncated
 * mid-JSON on a large model, and entryId was silently ignored on documents
 * — a document's content is an array (`brain-cache.ts`), but the narrowing
 * branch only fired for a plain object, so the whole model came back every
 * time and, on a singleton, `entryId` was looked up as a FIELD NAME on the
 * one record instead — almost always a miss, read back as `data: null` (#287).
 */

const PERMISSIONS: AgentPermissions = {
  workspaceRole: 'owner',
  projectRole: null,
  specificModels: false,
  allowedModels: [],
  allowedLocales: [],
  availableTools: ['brain_query'],
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

async function query(params: Record<string, unknown>) {
  const { emptyAffected } = await import('../../server/utils/agent-types')
  vi.stubGlobal('emptyAffected', emptyAffected)
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))

  const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
  const { result } = await executeToolWithAutoMerge(
    'brain_query',
    params,
    {} as never,
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
  return result as Record<string, unknown>
}

/** A `tr`-locale articles collection: 3 entries, two categories. */
function articlesBrain() {
  return {
    content: new Map<string, unknown>([
      ['articles:tr', {
        a1: { title: 'Creator Economy', category: 'business', publish_at: '2026-01-01' },
        a2: { title: 'TikTok Rewards', category: 'social', publish_at: '2026-03-01' },
        a3: { title: 'Startup Funding', category: 'business', publish_at: '2026-02-01' },
      }],
    ]),
    meta: new Map<string, Record<string, unknown>>([
      ['articles:tr', {
        a1: { status: 'published' },
        a2: { status: 'draft' },
        a3: { status: 'published' },
      }],
    ]),
    models: new Map([['articles', { id: 'articles', kind: 'collection' }]]),
  }
}

/** A `tr`-locale guides document model: 2 slugs. */
function guidesBrain() {
  return {
    content: new Map<string, unknown>([
      ['guides:tr', [
        { slug: 'getting-started', frontmatter: { title: 'Getting Started', order: 1 }, body: '# Hello' },
        { slug: 'advanced', frontmatter: { title: 'Advanced', order: 2 }, body: '# Deep dive' },
      ]],
    ]),
    meta: new Map<string, Record<string, unknown>>([
      ['guides:tr', {
        'getting-started': { status: 'published' },
        'advanced': { status: 'draft' },
      }],
    ]),
    models: new Map([['guides', { id: 'guides', kind: 'document' }]]),
  }
}

describe('brain_query entryId resolves by kind (#287)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('resolves entryId against a document slug (previously always ignored)', async () => {
    stubBrain(guidesBrain())

    const result = await query({ model: 'guides', locale: 'tr', entryId: 'advanced' })

    expect(result).toMatchObject({
      entryId: 'advanced',
      meta: { status: 'draft' },
      data: { slug: 'advanced', title: 'Advanced', order: 2, body: '# Deep dive' },
    })
  })

  it('returns null data for a document slug that does not exist, not the whole model', async () => {
    stubBrain(guidesBrain())

    const result = await query({ model: 'guides', locale: 'tr', entryId: 'missing' })

    expect(result).toMatchObject({ entryId: 'missing', data: null })
  })

  it('ignores entryId on a singleton instead of looking it up as a field name', async () => {
    stubBrain({
      content: new Map<string, unknown>([['settings:en', { site_title: 'Collabers', entryId: 'not-a-real-field-value' }]]),
      meta: new Map<string, Record<string, unknown>>([['settings:en', { status: 'published' }]]),
      models: new Map([['settings', { id: 'settings', kind: 'singleton' }]]),
    })

    const result = await query({ model: 'settings', locale: 'en', entryId: 'site_title' })

    // Not `data: null` (the old behaviour of reading contentData['site_title']
    // as if entryId were a key into the flat record) — the whole record.
    expect(result).toMatchObject({ data: { site_title: 'Collabers', entryId: 'not-a-real-field-value' } })
    expect(result).not.toHaveProperty('entryId')
  })

  it('ignores entryId on a dictionary the same way', async () => {
    stubBrain({
      content: new Map<string, unknown>([['ui-strings:en', { 'auth.title': 'Sign in', 'auth.subtitle': 'Welcome back' }]]),
      meta: new Map<string, Record<string, unknown>>(),
      models: new Map([['ui-strings', { id: 'ui-strings', kind: 'dictionary' }]]),
    })

    const result = await query({ model: 'ui-strings', locale: 'en', entryId: 'auth.title' })

    expect(result).toMatchObject({ data: { 'auth.title': 'Sign in', 'auth.subtitle': 'Welcome back' } })
  })
})

describe('brain_query listing: where / sort / fields (#287)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('filters a collection by exact field match', async () => {
    stubBrain(articlesBrain())

    const result = await query({ model: 'articles', locale: 'tr', where: { category: 'business' } })

    const ids = (result.data as Array<{ id: string }>).map(e => e.id)
    expect(ids.sort()).toEqual(['a1', 'a3'])
    expect(result.total).toBe(2)
  })

  it('filters a document listing by a frontmatter field', async () => {
    stubBrain(guidesBrain())

    const result = await query({ model: 'guides', locale: 'tr', where: { order: 2 } })

    expect((result.data as Array<{ slug: string }>).map(e => e.slug)).toEqual(['advanced'])
  })

  it('matches nothing rather than everything when no entry satisfies where', async () => {
    stubBrain(articlesBrain())

    const result = await query({ model: 'articles', locale: 'tr', where: { category: 'nonexistent' } })

    expect(result.data).toEqual([])
    expect(result.total).toBe(0)
  })

  it('sorts ascending and descending by a named field', async () => {
    stubBrain(articlesBrain())

    const asc = await query({ model: 'articles', locale: 'tr', sort: { field: 'publish_at' } })
    expect((asc.data as Array<{ id: string }>).map(e => e.id)).toEqual(['a1', 'a3', 'a2'])

    const desc = await query({ model: 'articles', locale: 'tr', sort: { field: 'publish_at', direction: 'desc' } })
    expect((desc.data as Array<{ id: string }>).map(e => e.id)).toEqual(['a2', 'a3', 'a1'])
  })

  it('sorts entries missing the field to the end regardless of direction', async () => {
    stubBrain({
      content: new Map<string, unknown>([['articles:tr', {
        a1: { title: 'Has date', publish_at: '2026-01-01' },
        a2: { title: 'No date' },
      }]]),
      meta: new Map(),
      models: new Map([['articles', { id: 'articles', kind: 'collection' }]]),
    })

    for (const direction of ['asc', 'desc'] as const) {
      const result = await query({ model: 'articles', locale: 'tr', sort: { field: 'publish_at', direction } })
      expect((result.data as Array<{ id: string }>).map(e => e.id)).toEqual(['a1', 'a2'])
    }
  })

  it('projects only the requested fields, plus the entry\'s id', async () => {
    stubBrain(articlesBrain())

    const result = await query({ model: 'articles', locale: 'tr', fields: ['title'] })

    for (const entry of result.data as Array<Record<string, unknown>>) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'title'])
    }
  })

  it('projects with the slug as the identity field for documents', async () => {
    stubBrain(guidesBrain())

    const result = await query({ model: 'guides', locale: 'tr', fields: ['title'] })

    for (const entry of result.data as Array<Record<string, unknown>>) {
      expect(Object.keys(entry).sort()).toEqual(['slug', 'title'])
    }
  })

  it('combines where, sort and fields in one call', async () => {
    stubBrain(articlesBrain())

    const result = await query({
      model: 'articles',
      locale: 'tr',
      where: { category: 'business' },
      sort: { field: 'publish_at', direction: 'desc' },
      fields: ['title'],
    })

    expect(result.data).toEqual([
      { id: 'a3', title: 'Startup Funding' },
      { id: 'a1', title: 'Creator Economy' },
    ])
  })
})

describe('brain_query listing: pagination replaces silent truncation (#287)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  function bigCollection(count: number) {
    const content: Record<string, unknown> = {}
    for (let i = 0; i < count; i++) content[`a${i}`] = { title: `Article ${i}` }
    return {
      content: new Map<string, unknown>([['articles:tr', content]]),
      meta: new Map(),
      models: new Map([['articles', { id: 'articles', kind: 'collection' }]]),
    }
  }

  it('caps a listing at the default page size and reports truncated: true', async () => {
    stubBrain(bigCollection(45))

    const result = await query({ model: 'articles', locale: 'tr' })

    expect(result.total).toBe(45)
    expect(result.returned).toBe(20)
    expect(result.offset).toBe(0)
    expect(result.truncated).toBe(true)
    expect((result.data as unknown[]).length).toBe(20)
  })

  it('pages through with offset until truncated: false', async () => {
    stubBrain(bigCollection(25))

    const first = await query({ model: 'articles', locale: 'tr', limit: 20 })
    expect(first.truncated).toBe(true)

    const second = await query({ model: 'articles', locale: 'tr', limit: 20, offset: 20 })
    expect(second.returned).toBe(5)
    expect(second.truncated).toBe(false)
  })

  it('reports truncated: false and the full page when everything fits', async () => {
    stubBrain(articlesBrain())

    const result = await query({ model: 'articles', locale: 'tr' })

    expect(result.total).toBe(3)
    expect(result.returned).toBe(3)
    expect(result.truncated).toBe(false)
  })

  it('caps an explicit limit at the maximum instead of returning everything', async () => {
    stubBrain(bigCollection(150))

    const result = await query({ model: 'articles', locale: 'tr', limit: 1000 })

    expect(result.returned).toBe(100)
  })

  it('only returns meta for the entries on the page, not the whole model', async () => {
    stubBrain(bigCollection(45))

    const result = await query({ model: 'articles', locale: 'tr', limit: 5 })

    expect(Object.keys(result.meta as Record<string, unknown>).length).toBeLessThanOrEqual(5)
  })
})
