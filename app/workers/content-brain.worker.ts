/**
 * Content Brain Web Worker.
 *
 * Manages client-side content cache in IndexedDB + FlexSearch full-text index.
 * Communicates with main thread via postMessage.
 * Cross-tab sync via BroadcastChannel.
 */

import { del, get, keys, set } from 'idb-keyval'
// A worker has no Nuxt auto-imports, so these are explicit.
import { collectSearchHits, indexFetchLimit } from '../utils/search-results'
import { createSharedStores } from './brain-idb-store'

// Both stores live in one 'cr-brain' database, opened once. idb-keyval's own
// `createStore` cannot do that — see brain-idb-store.ts for why it matters.
const { 'brain-meta': metaStore, 'brain-content': contentStore } = createSharedStores(
  'cr-brain',
  ['brain-meta', 'brain-content'],
)

// FlexSearch index (no published types — use any). Built on the first search,
// not on load: FlexSearch is imported lazily so the worker can answer `init`
// — the cache key and the cached snapshot — before that module is even fetched.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let searchIndex: any = null
// The build in flight, so concurrent searches share it instead of each building.
let indexBuild: Promise<void> | null = null
// Bumped whenever the content under the index changes; a build that started
// before the change must not install an index of the old content.
let indexGeneration = 0

// BroadcastChannel for cross-tab sync
const channel = new BroadcastChannel('cr-brain')

let currentProjectId: string | null = null

// eslint-disable-next-line no-console
console.log('[brain-worker] Worker initialized, ready for messages')

// --- Message Handler ---

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data
  // eslint-disable-next-line no-console
  console.log('[brain-worker] Received message:', msg.type)

  try {
    switch (msg.type) {
      case 'init': {
        currentProjectId = msg.projectId
        // eslint-disable-next-line no-console
        console.log('[brain-worker] Init for project:', msg.projectId)
        // The cache key AND the cached snapshot, in one message. The main
        // thread only sends the key once this arrives, and the server answers
        // a matching key with an empty delta — so the snapshot has to be in
        // hand by then, and it has to be exactly what that key stands for.
        // Both come out of the one meta record, which a sync writes last.
        const cachedMeta = await get(`${msg.projectId}:meta`, metaStore) as CachedMeta | undefined
        const current = isCurrentMeta(cachedMeta)
        self.postMessage({
          type: 'ready',
          treeSha: current ? cachedMeta.treeSha ?? null : null,
          cached: !!cachedMeta,
          snapshot: current ? await readSnapshot(msg.projectId, cachedMeta) : null,
        })
        break
      }

      case 'sync': {
        const { payload, projectId } = msg

        if (payload.delta && !payload.config && !payload.models && !payload.content) {
          // No changes on the server. The search index is still built from
          // IndexedDB — on the first search, which calls `ensureSearchIndex`.
          self.postMessage({ type: 'synced', treeSha: payload.treeSha, stats: null })
          break
        }

        // Order matters. The meta record carries the key the next load offers
        // the server, and a matching key is answered with nothing — so it is
        // written LAST, after everything it vouches for. A sync cut short
        // before then (reload, project switch) leaves the previous meta, whose
        // key the server no longer matches: the next load syncs in full.
        const liveKeys = new Set<string>()

        // Store models
        if (payload.models) {
          for (const [modelId, def] of Object.entries(payload.models)) {
            await set(`${projectId}:model:${modelId}`, def, contentStore)
            liveKeys.add(`${projectId}:model:${modelId}`)
          }
        }

        // Store content + meta
        let totalEntries = 0
        if (payload.content) {
          for (const [key, value] of Object.entries(payload.content as Record<string, { data: unknown, meta: unknown, kind: string }>)) {
            await set(`${projectId}:content:${key}`, value.data, contentStore)
            liveKeys.add(`${projectId}:content:${key}`)
            if (value.meta) {
              await set(`${projectId}:meta:${key}`, value.meta, contentStore)
              liveKeys.add(`${projectId}:meta:${key}`)
            }
            // Count entries
            if (value.data && typeof value.data === 'object') {
              if (Array.isArray(value.data)) totalEntries += value.data.length
              else totalEntries += Object.keys(value.data).length
            }
          }
        }

        // A full answer is the whole project: whatever it no longer has — a
        // deleted model, a dropped locale — goes, or a query would still find it.
        if (!payload.delta) await pruneProject(projectId, liveKeys)

        await set(`${projectId}:meta`, {
          treeSha: payload.treeSha,
          config: payload.config,
          // The definitions the screen lists, in the server's order, in the
          // same record as the key — so a snapshot can never pair this key
          // with another tree's models.
          models: Object.values(payload.models ?? {}),
          vocabulary: payload.vocabulary,
          contentContext: payload.contentContext,
          contentSummary: payload.contentSummary,
          // Cached so a delta load still has the health report: the server
          // answers an unchanged tree with nothing at all.
          schemaValidation: payload.schemaValidation ?? null,
          timestamp: Date.now(),
        } satisfies CachedMeta, metaStore)

        // The index now describes old content; the next search rebuilds it.
        dropSearchIndex()

        // Notify other tabs
        channel.postMessage({ type: 'synced', projectId, treeSha: payload.treeSha })

        self.postMessage({
          type: 'synced',
          treeSha: payload.treeSha,
          stats: {
            models: payload.models ? Object.keys(payload.models).length : 0,
            entries: totalEntries,
          },
        })
        break
      }

      case 'query': {
        const { id, modelId, locale, projectId } = msg
        const key = `${projectId}:content:${modelId}:${locale}`
        const data = await get(key, contentStore)
        const meta = await get(`${projectId}:meta:${modelId}:${locale}`, contentStore)
        const modelDef = await get(`${projectId}:model:${modelId}`, contentStore)

        self.postMessage({
          type: 'queryResult',
          id,
          data: {
            data: data ?? null,
            meta: meta ?? null,
            kind: (modelDef as { kind?: string })?.kind ?? 'collection',
          },
        })
        break
      }

      case 'search': {
        const { id, query, modelId: searchModelId, locale: searchLocale, limit } = msg
        // Belt and braces: every path that can leave a worker without an index
        // — a cross-tab sync, an invalidate, a cached load — ends up here
        // rather than silently answering nothing.
        await ensureSearchIndex(currentProjectId)
        const filters = { modelId: searchModelId, locale: searchLocale, limit: limit ?? 10 }
        let results: Array<{ modelId: string, entryId: string, locale: string, score: number }> = []

        if (searchIndex) {
          const flexResults = searchIndex.search(query, { limit: indexFetchLimit(filters) })
          // One result set per indexed field, flattened in rank order.
          const docIds = flexResults.flatMap((field: { result: unknown[] }) => field.result.map(String))
          results = collectSearchHits(
            docIds,
            (docId: string) => searchIndex.get(docId),
            filters,
          )
        }

        self.postMessage({ type: 'searchResult', id, results })
        break
      }

      case 'getSnapshot': {
        const { projectId } = msg
        const cachedMeta = await get(`${projectId}:meta`, metaStore)
        self.postMessage({ type: 'snapshot', data: await readSnapshot(projectId, cachedMeta) })
        break
      }

      case 'getModelContent': {
        const { projectId, modelId, locale } = msg
        const key = `${projectId}:content:${modelId}:${locale}`
        const data = await get(key, contentStore)
        const contentMeta = await get(`${projectId}:meta:${modelId}:${locale}`, contentStore)
        const modelDef = await get(`${projectId}:model:${modelId}`, contentStore)

        self.postMessage({
          type: 'modelContent',
          data: {
            data: data ?? null,
            kind: (modelDef as { kind?: string })?.kind ?? 'collection',
            meta: contentMeta ?? null,
          },
        })
        break
      }

      case 'invalidate': {
        const { projectId } = msg
        // Clear all entries for this project
        const allMetaKeys = await keys(metaStore)
        for (const k of allMetaKeys) {
          if (String(k).startsWith(`${projectId}:`)) await del(k, metaStore)
        }
        const allContentKeys = await keys(contentStore)
        for (const k of allContentKeys) {
          if (String(k).startsWith(`${projectId}:`)) await del(k, contentStore)
        }
        dropSearchIndex()
        self.postMessage({ type: 'invalidated' })
        break
      }

      case 'destroy': {
        dropSearchIndex()
        currentProjectId = null
        channel.close()
        self.close()
        break
      }
    }
  }
  catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Worker error',
    })
  }
}

// Listen for syncs from other tabs
channel.onmessage = (event: MessageEvent) => {
  if (event.data.type === 'synced' && event.data.projectId === currentProjectId) {
    // Another tab synced — notify main thread to refresh state
    self.postMessage({ type: 'externalSync', treeSha: event.data.treeSha })
  }
}

interface CachedMeta {
  treeSha?: string | null
  config?: unknown
  models?: unknown[]
  vocabulary?: unknown
  contentContext?: unknown
  contentSummary?: unknown
  schemaValidation?: unknown
  timestamp?: number
}

/**
 * Whether this meta record is self-contained: its key, its models and its
 * health report written together by one sync.
 *
 * A cache written before that kept its models in separate keys, which could
 * belong to another tree (never pruned, or written after the key by a sync
 * that was cut short), and held no health report. Its key is withheld and its
 * snapshot not shown — one full sync rewrites it in the current shape.
 */
function isCurrentMeta(meta: CachedMeta | undefined): meta is CachedMeta {
  return !!meta && Array.isArray(meta.models) && 'schemaValidation' in meta
}

/**
 * Everything the screen needs, read out of IndexedDB. A current meta holds it
 * all; an older one falls back to the model keys (only the error and
 * cross-tab paths ask for that — never the key-bearing `ready`).
 */
async function readSnapshot(projectId: string, meta: CachedMeta | undefined) {
  let models = meta?.models
  if (!Array.isArray(models)) {
    models = []
    for (const k of await keys(contentStore)) {
      if (!String(k).startsWith(`${projectId}:model:`)) continue
      const def = await get(k, contentStore)
      if (def) models.push(def)
    }
  }

  return {
    exists: !!meta?.config,
    config: meta?.config ?? null,
    models,
    content: meta?.contentSummary ?? {},
    vocabulary: meta?.vocabulary ?? null,
    contentContext: meta?.contentContext ?? null,
    // Left undefined for a cache that never stored one, so the main thread
    // keeps whatever it already has instead of clearing it.
    schemaValidation: meta?.schemaValidation,
  }
}

/** Delete this project's model and content keys that `live` does not list. */
async function pruneProject(projectId: string, live: Set<string>) {
  const prefixes = [`${projectId}:model:`, `${projectId}:content:`, `${projectId}:meta:`]
  for (const k of await keys(contentStore)) {
    const key = String(k)
    if (prefixes.some(p => key.startsWith(p)) && !live.has(key)) await del(k, contentStore)
  }
}

function dropSearchIndex() {
  indexGeneration++
  searchIndex = null
  indexBuild = null
}

/**
 * Build the index if this worker does not have one yet.
 *
 * Cheap when it already does, which is what lets every entry point call it
 * without thinking about whether some other one already has. Concurrent calls
 * share one build.
 */
async function ensureSearchIndex(projectId: string | null) {
  if (!projectId) return
  // A sync can drop the index while a build is running. That build then
  // installs nothing, and the next pass builds over the newer content.
  for (let attempt = 0; attempt < 3 && !searchIndex; attempt++) {
    if (!indexBuild) {
      const generation = indexGeneration
      indexBuild = buildSearchIndex(projectId).then((index) => {
        if (generation === indexGeneration) searchIndex = index
      }).finally(() => {
        if (generation === indexGeneration) indexBuild = null
      })
    }
    await indexBuild
  }
}

async function buildSearchIndex(projectId: string) {
  const { default: FlexSearch } = await import('flexsearch')
  const index = new FlexSearch.Document({
    document: {
      id: 'id',
      index: ['text'],
      store: ['modelId', 'entryId', 'locale'],
    },
    tokenize: 'forward',
  })

  const allKeys = await keys(contentStore)

  for (const k of allKeys) {
    const keyStr = String(k)
    if (!keyStr.startsWith(`${projectId}:content:`)) continue

    const parts = keyStr.replace(`${projectId}:content:`, '').split(':')
    const modelId = parts[0]
    const locale = parts[1]
    if (!modelId || !locale) continue

    const data = await get(k, contentStore)
    if (!data) continue

    if (typeof data === 'object' && !Array.isArray(data) && data !== null) {
      // Collection/singleton/dictionary
      for (const [entryId, entry] of Object.entries(data as Record<string, unknown>)) {
        const text = extractSearchableText(entry)
        if (text) {
          index.add({
            id: `${modelId}:${locale}:${entryId}`,
            text,
            modelId,
            entryId,
            locale,
          })
        }
      }
    }
    else if (Array.isArray(data)) {
      // Document kind
      for (const entry of data) {
        if (typeof entry === 'object' && entry !== null) {
          const doc = entry as Record<string, unknown>
          const slug = (doc.slug as string) ?? ''
          const text = extractSearchableText(doc)
          if (text && slug) {
            index.add({
              id: `${modelId}:${locale}:${slug}`,
              text,
              modelId,
              entryId: slug,
              locale,
            })
          }
        }
      }
    }
  }

  return index
}

function extractSearchableText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return ''

  const parts: string[] = []
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0 && v.length < 5000) {
      parts.push(v)
    }
  }
  return parts.join(' ')
}
