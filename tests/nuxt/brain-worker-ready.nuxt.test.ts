import 'fake-indexeddb/auto'
import { get, set } from 'idb-keyval'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createSharedStores } from '../../app/workers/brain-idb-store'

/**
 * What a reloaded brain worker reports on `init`.
 *
 * Once the cache key reaches the server, an unchanged project is answered with
 * an empty delta — so everything the screen shows on a warm reload has to come
 * out of IndexedDB, and it has to arrive with the key. These tests populate
 * IndexedDB through a real sync, then boot a fresh worker over it.
 */

const PROJECT = 'project-ready'

const SYNC_PAYLOAD = {
  treeSha: 'd'.repeat(64),
  delta: false,
  config: { locales: { default: 'tr', supported: ['tr'] } },
  models: {
    articles: { id: 'articles', name: 'Articles', kind: 'collection' },
    authors: { id: 'authors', name: 'Authors', kind: 'collection' },
  },
  content: {
    'articles:tr': { data: { a1: { title: 'Merhaba' } }, meta: null, kind: 'collection' },
  },
  vocabulary: { cta: { tr: 'Başla' } },
  contentContext: null,
  contentSummary: { articles: { count: 1, locales: ['tr'], kind: 'collection' } },
  schemaValidation: { valid: true, warnings: [], healthScore: 91, modelCount: 2, validModels: 2, timestamp: 't' },
}

let posted: Array<Record<string, unknown>> = []

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
  const first = await bootWorker()
  await first({ type: 'init', projectId: PROJECT })
  await first({ type: 'sync', projectId: PROJECT, payload: SYNC_PAYLOAD })
})

describe('brain worker init on a warm reload', () => {
  it('hands over the cached snapshot together with the key', async () => {
    const handle = await bootWorker()
    await handle({ type: 'init', projectId: PROJECT })

    const ready = lastOfType('ready') as { treeSha: string, cached: boolean, snapshot: Record<string, unknown> }
    expect(ready.treeSha).toBe(SYNC_PAYLOAD.treeSha)
    expect(ready.cached).toBe(true)
    expect(ready.snapshot).toMatchObject({
      exists: true,
      config: SYNC_PAYLOAD.config,
      content: SYNC_PAYLOAD.contentSummary,
      vocabulary: SYNC_PAYLOAD.vocabulary,
      schemaValidation: SYNC_PAYLOAD.schemaValidation,
    })
    expect((ready.snapshot.models as Array<{ id: string }>).map(m => m.id).toSorted()).toEqual(['articles', 'authors'])
  })

  it('withholds the key of a cache written before the health report was stored', async () => {
    // Offering that key would earn an empty delta, and the health report would
    // never arrive. Without it the server sends everything, once.
    const { 'brain-meta': metaStore } = createSharedStores('cr-brain', ['brain-meta', 'brain-content'])
    const key = `${PROJECT}:meta`
    const meta = await get(key, metaStore) as Record<string, unknown>
    const { schemaValidation: _dropped, ...legacy } = meta
    await set(key, legacy, metaStore)

    const handle = await bootWorker()
    await handle({ type: 'init', projectId: PROJECT })

    const ready = lastOfType('ready') as { treeSha: string | null, cached: boolean, snapshot: Record<string, unknown> }
    expect(ready.treeSha).toBeNull()
    // The cache still renders while the full sync is on its way.
    expect(ready.cached).toBe(true)
    expect(ready.snapshot.config).toEqual(SYNC_PAYLOAD.config)

    await set(key, meta, metaStore)
  })

  it('reports no snapshot for a project this browser never synced', async () => {
    const handle = await bootWorker()
    await handle({ type: 'init', projectId: 'never-seen' })

    expect(lastOfType('ready')).toMatchObject({ treeSha: null, cached: false, snapshot: null })
  })
})
