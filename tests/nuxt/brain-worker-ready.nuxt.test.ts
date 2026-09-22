import 'fake-indexeddb/auto'
import { get, set } from 'idb-keyval'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createSharedStores } from '../../app/workers/brain-idb-store'

// Lets a test cut a sync short at a given key, the way a reload or a project
// switch (`destroyBrain` → `terminate`) does.
const writes = vi.hoisted(() => ({ failAt: null as string | null }))
vi.mock('idb-keyval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('idb-keyval')>()
  return {
    ...actual,
    set: (key: IDBValidKey, value: unknown, store?: Parameters<typeof actual.set>[2]) =>
      writes.failAt === String(key) ? Promise.reject(new Error('worker terminated')) : actual.set(key, value, store),
  }
})

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
  // Server order, deliberately not alphabetical.
  models: {
    authors: { id: 'authors', name: 'Authors', kind: 'collection' },
    articles: { id: 'articles', name: 'Articles', kind: 'collection' },
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
    // In the server's order, as a full answer lists them.
    expect((ready.snapshot.models as Array<{ id: string }>).map(m => m.id)).toEqual(['authors', 'articles'])
  })

  it.each([
    ['no health report', 'schemaValidation'],
    ['models kept only in separate keys', 'models'],
  ])('withholds the key and the snapshot of an older cache (%s)', async (_label, field) => {
    // Offering that key would earn an empty delta and pin whatever the old
    // shape got wrong. Without it the server sends everything, once.
    const { 'brain-meta': metaStore } = createSharedStores('cr-brain', ['brain-meta', 'brain-content'])
    const key = `${PROJECT}:meta`
    const meta = await get(key, metaStore) as Record<string, unknown>
    const { [field]: _dropped, ...legacy } = meta
    await set(key, legacy, metaStore)

    const handle = await bootWorker()
    await handle({ type: 'init', projectId: PROJECT })

    expect(lastOfType('ready')).toMatchObject({ treeSha: null, cached: true, snapshot: null })

    await set(key, meta, metaStore)
  })

  it('does not bring back a model the project no longer has', async () => {
    // Sync {authors, articles}, then {articles}. The warm snapshot must say
    // {articles}: the server answers its key with an empty delta, so anything
    // extra in it would sit in the sidebar with nothing to ever remove it.
    const first = await bootWorker()
    await first({ type: 'init', projectId: 'pruned' })
    await first({ type: 'sync', projectId: 'pruned', payload: { ...SYNC_PAYLOAD, treeSha: 'a'.repeat(64) } })
    await first({
      type: 'sync',
      projectId: 'pruned',
      payload: {
        ...SYNC_PAYLOAD,
        treeSha: 'b'.repeat(64),
        models: { articles: SYNC_PAYLOAD.models.articles },
        content: { 'articles:tr': SYNC_PAYLOAD.content['articles:tr'] },
      },
    })

    const handle = await bootWorker()
    await handle({ type: 'init', projectId: 'pruned' })
    const ready = lastOfType('ready') as { treeSha: string, snapshot: { models: Array<{ id: string }> } }
    expect(ready.treeSha).toBe('b'.repeat(64))
    expect(ready.snapshot.models.map(m => m.id)).toEqual(['articles'])

    // Nor can a query find its content.
    await handle({ type: 'query', id: 'q1', projectId: 'pruned', modelId: 'authors', locale: 'tr' })
    expect(lastOfType('queryResult')).toMatchObject({ data: { data: null } })
  })

  it('keeps the previous key when a sync is cut short', async () => {
    // The worker dies after writing the new models but before the meta. The
    // next load must not offer the new tree's key over the old tree's record —
    // it offers the old key, which the server no longer matches, and syncs in full.
    const first = await bootWorker()
    await first({ type: 'init', projectId: 'torn' })
    await first({ type: 'sync', projectId: 'torn', payload: { ...SYNC_PAYLOAD, treeSha: 'a'.repeat(64) } })

    writes.failAt = 'torn:meta'
    await first({
      type: 'sync',
      projectId: 'torn',
      payload: { ...SYNC_PAYLOAD, treeSha: 'b'.repeat(64), models: { articles: SYNC_PAYLOAD.models.articles } },
    })
    writes.failAt = null
    expect(lastOfType('error')).toBeDefined()

    const handle = await bootWorker()
    await handle({ type: 'init', projectId: 'torn' })
    const ready = lastOfType('ready') as { treeSha: string, snapshot: { models: Array<{ id: string }> } }
    expect(ready.treeSha).toBe('a'.repeat(64))
    // ...and the snapshot is the one that key stands for.
    expect(ready.snapshot.models.map(m => m.id)).toEqual(['authors', 'articles'])
  })

  it('reports no snapshot for a project this browser never synced', async () => {
    const handle = await bootWorker()
    await handle({ type: 'init', projectId: 'never-seen' })

    expect(lastOfType('ready')).toMatchObject({ treeSha: null, cached: false, snapshot: null })
  })
})
