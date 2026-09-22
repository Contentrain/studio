import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

// Counts the search indexes the worker builds, and can make building fail the
// way it does when the lazily imported chunk cannot be loaded.
const flexsearch = vi.hoisted(() => ({ builds: 0, fail: false }))
vi.mock('flexsearch', async (importOriginal) => {
  const actual = await importOriginal<{ default: { Document: new (options: unknown) => unknown } }>()
  class CountingDocument extends (actual.default.Document as new (options: unknown) => object) {
    constructor(options: unknown) {
      if (flexsearch.fail) throw new TypeError('Failed to fetch dynamically imported module')
      super(options)
      flexsearch.builds++
    }
  }
  return { ...actual, default: { ...actual.default, Document: CountingDocument } }
})

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

  it('does not import FlexSearch at the top of the worker', () => {
    // The worker answers `init` — the cache key and the cached snapshot —
    // without it. A top-level import made that first answer wait for the whole
    // library to load.
    const source = readFileSync(resolve(process.cwd(), 'app/workers/content-brain.worker.ts'), 'utf8')
    expect(source).not.toMatch(/^import\b[^\n]*['"]flexsearch['"]/m)
    expect(source).toMatch(/await import\('flexsearch'\)/)
  })

  it('builds no index for init, then one after the sync that searches share', async () => {
    const fresh = await bootWorker()
    flexsearch.builds = 0
    await fresh({ type: 'init', projectId: PROJECT })
    expect(flexsearch.builds).toBe(0)

    await fresh({ type: 'sync', projectId: PROJECT, payload: SYNC_PAYLOAD })
    await fresh({ type: 'sync', projectId: PROJECT, payload: { delta: true, treeSha: 'sha-1' } })
    await fresh({ type: 'search', id: 's5', query: 'creator', limit: 10 })
    await fresh({ type: 'search', id: 's5b', query: 'friday', limit: 10 })
    expect(flexsearch.builds).toBe(1)
    expect((lastOfType('searchResult')?.results as unknown[]).length).toBeGreaterThan(0)
  })

  it('starts the build after the sync, before anyone searches', async () => {
    const fresh = await bootWorker()
    await fresh({ type: 'init', projectId: PROJECT })
    flexsearch.builds = 0
    await fresh({ type: 'sync', projectId: PROJECT, payload: { delta: true, treeSha: 'sha-1' } })

    await vi.waitFor(() => expect(flexsearch.builds).toBe(1))
  })

  it('answers no results, not a worker error, when the index cannot be built', async () => {
    const fresh = await bootWorker()
    const seen: Array<Record<string, unknown>> = []
    const run = async (msg: Record<string, unknown>) => {
      await fresh(msg)
      seen.push(...posted)
    }
    flexsearch.fail = true
    try {
      await run({ type: 'init', projectId: PROJECT })
      await run({ type: 'sync', projectId: PROJECT, payload: { delta: true, treeSha: 'sha-1' } })
      await run({ type: 'search', id: 's8', query: 'creator', limit: 10 })

      expect(lastOfType('searchResult')).toMatchObject({ id: 's8', results: [] })
      expect(seen.filter(m => m.type === 'error')).toEqual([])
    }
    finally {
      flexsearch.fail = false
    }

    // Nothing is left broken: the next search builds the index.
    await run({ type: 'search', id: 's9', query: 'creator', limit: 10 })
    expect((lastOfType('searchResult')?.results as unknown[]).length).toBeGreaterThan(0)
  })

  it('searches the new content after a sync replaced it', async () => {
    const fresh = await bootWorker()
    await fresh({ type: 'init', projectId: PROJECT })
    await fresh({ type: 'search', id: 's6', query: 'creator', limit: 10 })
    expect((lastOfType('searchResult')?.results as unknown[]).length).toBeGreaterThan(0)

    // The same project, now without anything that says "creator".
    await fresh({
      type: 'sync',
      projectId: PROJECT,
      payload: {
        ...SYNC_PAYLOAD,
        treeSha: 'sha-2',
        content: {
          'articles:en': { data: { a1: { title: 'Ship it on Friday', body: 'Nothing here' } }, meta: null, kind: 'collection' },
          'authors:en': { data: { u1: { name: 'Ahmet', bio: 'writer' } }, meta: null, kind: 'collection' },
        },
      },
    })
    await fresh({ type: 'search', id: 's7', query: 'creator', limit: 10 })

    expect(lastOfType('searchResult')?.results).toEqual([])

    // Put the shared IndexedDB back the way the other tests expect it.
    await fresh({ type: 'sync', projectId: PROJECT, payload: SYNC_PAYLOAD })
  })
})
