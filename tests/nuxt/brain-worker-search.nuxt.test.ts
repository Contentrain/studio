import 'fake-indexeddb/auto'
import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The brain worker's search, driven through its own message handler.
 *
 * The bug this exists for: a worker is created fresh on every page load and its
 * FlexSearch index lives only in memory, while the content it is built from
 * lives in IndexedDB and survives. The index was built in exactly one place —
 * after the "nothing changed" early return in `sync` — so reloading a project
 * nobody had edited left the worker with no index at all, and search answered
 * nothing, forever, with no error to show for it.
 *
 * So the test loads the worker twice: once to populate IndexedDB the way a real
 * session would, and again to be the reloaded worker that has never synced.
 */

const PROJECT = 'project-1'

const SYNC_PAYLOAD = {
  treeSha: 'sha-1',
  delta: false,
  config: { locales: { default: 'en', supported: ['en'] } },
  models: {
    articles: { id: 'articles', kind: 'collection' },
    authors: { id: 'authors', kind: 'collection' },
  },
  content: {
    'articles:en': {
      data: {
        a1: { title: 'Ship it on Friday', body: 'A note about the creator economy' },
        a2: { title: 'Something else entirely', body: 'Unrelated' },
      },
      meta: null,
      kind: 'collection',
    },
    'authors:en': {
      data: { u1: { name: 'Ahmet', bio: 'creator' } },
      meta: null,
      kind: 'collection',
    },
  },
  vocabulary: null,
  contentContext: null,
  contentSummary: null,
  schemaValidation: null,
}

let posted: Array<Record<string, unknown>> = []
let handle: (msg: Record<string, unknown>) => Promise<void>

/** Load a fresh copy of the worker module and return a way to talk to it. */
async function bootWorker() {
  vi.resetModules()
  posted = []
  const scope = { postMessage: (m: Record<string, unknown>) => posted.push(m), onmessage: null as unknown }
  vi.stubGlobal('self', scope)
  await import('../../app/workers/content-brain.worker')
  const onmessage = (scope as { onmessage: (e: { data: unknown }) => Promise<void> }).onmessage
  return async (msg: Record<string, unknown>) => {
    posted.length = 0
    await onmessage({ data: msg })
    await new Promise(r => setTimeout(r, 0))
  }
}

function lastOfType(type: string) {
  return posted.filter(m => m.type === type).at(-1)
}

beforeAll(async () => {
  vi.stubGlobal('BroadcastChannel', class {
    postMessage() {}
    close() {}
  })

  // A previous session: a real sync that stores the content and builds an index.
  const first = await bootWorker()
  await first({ type: 'init', projectId: PROJECT })
  await first({ type: 'sync', projectId: PROJECT, payload: SYNC_PAYLOAD })

  // The reload: a new worker, empty in memory, over the same IndexedDB.
  handle = await bootWorker()
})

describe('brain worker search after a reload', () => {
  it('builds the index even when the sync reports nothing changed', async () => {
    await handle({ type: 'init', projectId: PROJECT })
    expect(lastOfType('ready')).toMatchObject({ cached: true })

    // The server has nothing new — the case that used to skip index building.
    await handle({ type: 'sync', projectId: PROJECT, payload: { delta: true, treeSha: 'sha-1' } })
    expect(lastOfType('synced')).toBeDefined()

    await handle({ type: 'search', id: 's1', query: 'creator', limit: 10 })

    const results = lastOfType('searchResult')?.results as Array<{ entryId: string }>
    expect(results.length).toBeGreaterThan(0)
    expect(results.map(r => r.entryId)).toContain('a1')
  })

  it('scopes to one model without losing its matches to another', async () => {
    // `authors:u1` also matches "creator". Filtering after the limit is what
    // let another model's hits eat the caller's slots.
    await handle({ type: 'search', id: 's2', query: 'creator', modelId: 'articles', limit: 10 })

    const results = lastOfType('searchResult')?.results as Array<{ modelId: string, entryId: string }>
    expect(results.map(r => r.entryId)).toEqual(['a1'])
    expect(results.every(r => r.modelId === 'articles')).toBe(true)
  })

  it('returns nothing for a locale that holds nothing', async () => {
    await handle({ type: 'search', id: 's3', query: 'creator', locale: 'tr', limit: 10 })

    expect(lastOfType('searchResult')?.results).toEqual([])
  })

  it('answers a search made before any sync at all', async () => {
    // Nothing guarantees the order of `sync` and the first keystroke.
    const fresh = await bootWorker()
    await fresh({ type: 'init', projectId: PROJECT })
    await fresh({ type: 'search', id: 's4', query: 'creator', modelId: 'articles', limit: 10 })

    const results = lastOfType('searchResult')?.results as unknown[]
    expect(results.length).toBeGreaterThan(0)
  })
})
