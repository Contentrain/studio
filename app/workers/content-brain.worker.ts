/**
 * Content Brain Web Worker.
 *
 * Manages client-side content cache in IndexedDB + FlexSearch full-text index.
 * Communicates with main thread via postMessage.
 * Cross-tab sync via BroadcastChannel.
 */

import { createStore, del, get, keys, set } from 'idb-keyval'
import FlexSearch from 'flexsearch'

// Custom IDB stores in 'cr-brain' database
const metaStore = createStore('cr-brain', 'brain-meta')
const contentStore = createStore('cr-brain', 'brain-content')

// FlexSearch index
let searchIndex: FlexSearch.Document<{ id: string, text: string, modelId: string, entryId: string, locale: string }, true> | null = null

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
        // Load cached treeSha from IDB
        const cachedMeta = await get(`${msg.projectId}:meta`, metaStore)
        self.postMessage({
          type: 'ready',
          treeSha: cachedMeta?.treeSha ?? null,
          cached: !!cachedMeta,
        })
        break
      }

      case 'sync': {
        const { payload, projectId } = msg

        if (payload.delta && !payload.config && !payload.models && !payload.content) {
          // No changes — already up to date
          self.postMessage({ type: 'synced', treeSha: payload.treeSha, stats: null })
          break
        }

        // Store meta (config, vocabulary, context, treeSha)
        await set(`${projectId}:meta`, {
          treeSha: payload.treeSha,
          config: payload.config,
          vocabulary: payload.vocabulary,
          contentContext: payload.contentContext,
          contentSummary: payload.contentSummary,
          timestamp: Date.now(),
        }, metaStore)

        // Store models
        if (payload.models) {
          for (const [modelId, def] of Object.entries(payload.models)) {
            await set(`${projectId}:model:${modelId}`, def, contentStore)
          }
        }

        // Store content + meta
        let totalEntries = 0
        if (payload.content) {
          for (const [key, value] of Object.entries(payload.content as Record<string, { data: unknown, meta: unknown, kind: string }>)) {
            await set(`${projectId}:content:${key}`, value.data, contentStore)
            if (value.meta) {
              await set(`${projectId}:meta:${key}`, value.meta, contentStore)
            }
            // Count entries
            if (value.data && typeof value.data === 'object') {
              if (Array.isArray(value.data)) totalEntries += value.data.length
              else totalEntries += Object.keys(value.data).length
            }
          }
        }

        // Rebuild FlexSearch index
        await rebuildSearchIndex(projectId)

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
        const { id, query, modelId: searchModelId, limit } = msg
        const results: Array<{ modelId: string, entryId: string, locale: string, score: number }> = []

        if (searchIndex) {
          const flexResults = searchIndex.search(query, { limit: limit ?? 10 })
          for (const field of flexResults) {
            for (const resultId of field.result) {
              const doc = searchIndex.get(resultId as unknown as string)
              if (doc && (!searchModelId || doc.modelId === searchModelId)) {
                results.push({
                  modelId: doc.modelId,
                  entryId: doc.entryId,
                  locale: doc.locale,
                  score: 1,
                })
              }
            }
          }
        }

        self.postMessage({ type: 'searchResult', id, results })
        break
      }

      case 'getSnapshot': {
        const { projectId } = msg
        const cachedMeta = await get(`${projectId}:meta`, metaStore)

        // Collect all model definitions
        const allKeys = await keys(contentStore)
        const models: Record<string, unknown>[] = []
        for (const k of allKeys) {
          const keyStr = String(k)
          if (keyStr.startsWith(`${projectId}:model:`)) {
            const def = await get(k, contentStore)
            if (def) models.push(def as Record<string, unknown>)
          }
        }

        self.postMessage({
          type: 'snapshot',
          data: {
            exists: !!cachedMeta?.config,
            config: cachedMeta?.config ?? null,
            models,
            content: cachedMeta?.contentSummary ?? {},
            vocabulary: cachedMeta?.vocabulary ?? null,
            contentContext: cachedMeta?.contentContext ?? null,
          },
        })
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
        searchIndex = null
        self.postMessage({ type: 'invalidated' })
        break
      }

      case 'destroy': {
        searchIndex = null
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

async function rebuildSearchIndex(projectId: string) {
  searchIndex = new FlexSearch.Document({
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
          searchIndex.add({
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
            searchIndex.add({
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
