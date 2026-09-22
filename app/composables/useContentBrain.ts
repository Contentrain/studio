/**
 * Content Brain — single source of truth for all project content.
 *
 * Bridges the Content Brain Web Worker with reactive Vue state.
 * Replaces useSnapshot + useModelContent cache layers with unified brain.
 *
 * Data flow:
 *   initBrain(projectId) → Worker loads from IndexedDB (instant)
 *   sync(wsId, projId) → /api/brain/sync (delta) → Worker updates IDB + FlexSearch
 *   queryContent(modelId, locale) → Worker reads from IDB → returns reactive
 *   searchContent(query) → Worker searches FlexSearch → returns results
 */

import type { ContentrainConfig, ModelDefinition, ModelKind } from '@contentrain/types'

// Vite ?worker import — returns a constructor, not an instance
import ContentBrainWorker from '~/workers/content-brain.worker.ts?worker'
import { usableTreeSha } from '~~/shared/utils/tree-sha'

interface BrainSyncResponse {
  treeSha: string
  delta: boolean
  config: ContentrainConfig | null
  models: Record<string, ModelDefinition> | null
  content: Record<string, { data: unknown, meta: Record<string, unknown> | null, kind: string }> | null
  vocabulary: Record<string, Record<string, string>> | null
  contentContext: Record<string, unknown> | null
  contentSummary: Record<string, { count: number, locales: string[], kind: ModelKind }> | null
  schemaValidation: SchemaValidationResult | null
}

interface SchemaValidationWarning {
  modelId: string
  type: string
  field?: string
  previous?: string
  current?: string
  affectedEntries: number
  severity: 'critical' | 'error' | 'warning'
  message: string
}

interface SchemaValidationResult {
  valid: boolean
  warnings: SchemaValidationWarning[]
  healthScore: number
  modelCount: number
  validModels: number
  timestamp: string
}

interface ContentQueryResult {
  data: unknown
  kind: string
  meta: Record<string, unknown> | null
}

interface SearchResult {
  modelId: string
  entryId: string
  locale: string
  score: number
}

// Module-scoped shared state (singleton across all composable instances)
const pendingRequests = new Map<string, { resolve: (value: unknown) => void, reject: (reason: unknown) => void }>()
let requestCounter = 0
const sharedContentStore = new Map<string, { data: unknown, meta: Record<string, unknown> | null, kind: string }>()
let sharedWorker: Worker | null = null
let sharedProjectId: string | null = null
/**
 * Resolves when the worker has reported `ready` for `sharedProjectId` — i.e.
 * when the cache key it read out of IndexedDB has actually landed in
 * `treeSha`. `initBrain` only *posts* a message, so without this every caller
 * that syncs in the same tick reads `treeSha` before the worker answers.
 */
let workerReady: Promise<void> | null = null
let resolveWorkerReady: (() => void) | null = null
/**
 * Whether a full sync answer has been applied for `sharedProjectId`. The
 * cached snapshot that rides on `ready` must not overwrite it: when the worker
 * is slow enough that the sync went out without a key, the network answer is
 * the newer one.
 */
let networkApplied = false

interface CachedSnapshot {
  config: ContentrainConfig | null
  models: ModelDefinition[]
  content: Record<string, { count: number, locales: string[], kind: ModelKind }>
  vocabulary: Record<string, Record<string, string>> | null
  contentContext: Record<string, unknown> | null
  schemaValidation?: SchemaValidationResult | null
}

/**
 * Upper bound on how long a sync waits for the worker's cached key.
 *
 * Only a hung worker ever reaches it. The worker answers `init` with one
 * IndexedDB read (FlexSearch loads on the first search, not on boot), and a
 * project with a cache is on screen from that cache while the sync runs. 3s
 * was measured to be too short on a loaded machine: the worker answered in
 * 50s, and every reload in that state paid a full sync.
 */
const WORKER_READY_TIMEOUT_MS = 10_000

export function useContentBrain() {
  const treeSha = useState<string | null>('brain-tree-sha', () => null)
  const syncing = useState('brain-syncing', () => false)
  const ready = useState('brain-ready', () => false)
  // `sharedWorker` is a module-scope `let`, so a component cannot react to it.
  // Search needs to know, hence the mirror.
  const workerAvailable = useState('brain-worker-available', () => false)
  const syncError = useState<string | null>('brain-sync-error', () => null)
  const config = useState<ContentrainConfig | null>('brain-config', () => null)
  const models = useState<ModelDefinition[]>('brain-models', () => [])
  const vocabulary = useState<Record<string, Record<string, string>> | null>('brain-vocabulary', () => null)
  const contentContext = useState<Record<string, unknown> | null>('brain-content-context', () => null)
  const contentSummary = useState<Record<string, { count: number, locales: string[], kind: ModelKind }>>('brain-content-summary', () => ({}))
  const schemaValidation = useState<SchemaValidationResult | null>('brain-schema-validation', () => null)

  // --- Worker Lifecycle ---

  /**
   * Boot the worker for this project.
   *
   * Returns a promise that settles once the worker has reported back, so a
   * caller can sync *after* the cached key is in hand rather than racing it.
   * Callers that do not care can still ignore the return value.
   */
  function initBrain(projectId: string): Promise<void> {
    if (!import.meta.client) return Promise.resolve()

    // If already initialized for this project, skip
    if (sharedWorker && sharedProjectId === projectId) return workerReady ?? Promise.resolve()

    // Destroy previous worker if switching projects
    if (sharedWorker) destroyBrain()

    sharedProjectId = projectId
    workerReady = new Promise<void>((resolve) => {
      resolveWorkerReady = resolve
      // A missed cache costs one full sync; a gate that never opens costs the
      // whole screen, because `sync` holds `syncing` true while it waits. Cap
      // the wait so every worker failure this code did not anticipate degrades
      // to the old behaviour instead of hanging. The work behind it is a single
      // IndexedDB read.
      setTimeout(resolve, WORKER_READY_TIMEOUT_MS)
    })

    try {
      sharedWorker = new ContentBrainWorker()
      sharedWorker.onmessage = handleWorkerMessage
      sharedWorker.onerror = (e) => {
        // eslint-disable-next-line no-console
        console.error('[brain] Worker error:', e.message)
        resolveWorkerReady?.()
      }
      // eslint-disable-next-line no-console
      console.log('[brain] Worker created successfully, sending init for project:', projectId)
      sharedWorker.postMessage({ type: 'init', projectId })
      workerAvailable.value = true
    }
    catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[brain] Worker creation failed, using in-memory only mode:', e)
      sharedWorker = null
      workerAvailable.value = false
      // Nothing will ever send `ready`, so settle now — a sync that waits on a
      // worker that does not exist would hang instead of degrading.
      resolveWorkerReady?.()
    }

    return workerReady ?? Promise.resolve()
  }

  function destroyBrain() {
    if (sharedWorker) {
      sharedWorker.postMessage({ type: 'destroy' })
      sharedWorker.terminate()
      sharedWorker = null
    }
    workerAvailable.value = false
    sharedProjectId = null
    networkApplied = false
    // Release anyone still waiting on the worker we just terminated, then drop
    // the gate so the next `initBrain` installs a fresh one.
    resolveWorkerReady?.()
    workerReady = null
    resolveWorkerReady = null
    ready.value = false
    treeSha.value = null
    config.value = null
    models.value = []
    vocabulary.value = null
    contentContext.value = null
    contentSummary.value = {}
    schemaValidation.value = null
    sharedContentStore.clear()
    pendingRequests.clear()
  }

  /** Put what the worker read out of IndexedDB on screen. */
  function applySnapshot(data: CachedSnapshot) {
    config.value = data.config ?? null
    models.value = data.models ?? []
    vocabulary.value = data.vocabulary ?? null
    contentContext.value = data.contentContext ?? null
    contentSummary.value = data.content ?? {}
    // Absent in a cache written before it was stored — leave what is there.
    if (data.schemaValidation !== undefined) schemaValidation.value = data.schemaValidation
  }

  // --- Worker Message Handler ---

  function handleWorkerMessage(event: MessageEvent) {
    const msg = event.data
    // eslint-disable-next-line no-console
    console.log('[brain] Worker message:', msg.type, msg.id ?? '')

    switch (msg.type) {
      case 'ready':
        // eslint-disable-next-line no-console
        console.log('[brain] Worker ready, cached:', msg.cached, 'treeSha:', msg.treeSha)
        treeSha.value = msg.treeSha ?? null
        // The snapshot arrives with the key, so by the time a sync can send
        // that key — and get back an empty delta — the screen already has
        // what the key stands for.
        if (msg.snapshot && !networkApplied) applySnapshot(msg.snapshot)
        ready.value = !!msg.cached
        resolveWorkerReady?.()
        break

      case 'synced':
        treeSha.value = msg.treeSha
        syncing.value = false
        ready.value = true
        syncError.value = null
        break

      case 'snapshot':
        if (msg.data) applySnapshot(msg.data)
        break

      case 'queryResult':
      case 'searchResult':
      case 'modelContent': {
        const pending = pendingRequests.get(msg.id ?? msg.type)
        if (pending) {
          pending.resolve(msg.data ?? msg.results ?? null)
          pendingRequests.delete(msg.id ?? msg.type)
        }
        break
      }

      case 'externalSync':
        // Another tab synced — refresh our snapshot state
        if (sharedWorker && sharedProjectId) {
          sharedWorker.postMessage({ type: 'getSnapshot', projectId: sharedProjectId })
        }
        break

      case 'invalidated':
        ready.value = false
        break

      case 'error': {
        const { t } = useContent()
        syncError.value = t('content.sync_error')
        syncing.value = false
        // A worker that failed inside `init` will never send `ready`. Settle
        // the gate so the sync proceeds without a key rather than hanging.
        resolveWorkerReady?.()
        break
      }
    }
  }

  // --- Sync ---

  async function sync(workspaceId: string, projectId: string) {
    syncing.value = true
    syncError.value = null

    // The cache key lives in IndexedDB and only the worker can read it. Waiting
    // for it is the whole point: measured on staging, syncing in the same tick
    // as `initBrain` sent an empty query string on every single page load, so
    // the server answered with the full payload (22 KB) even though the browser
    // already held that exact content and the delta answer was 4.5 KB.
    if (import.meta.client && workerReady) await workerReady

    try {
      const params = new URLSearchParams()
      const key = usableTreeSha(treeSha.value)
      if (key) params.set('treeSha', key)

      const response = await $fetch<BrainSyncResponse>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/brain/sync?${params}`,
      )

      // Send sync payload to worker
      if (sharedWorker) {
        sharedWorker.postMessage({ type: 'sync', payload: response, projectId })
      }

      // Update reactive state from response (immediate, don't wait for worker)

      if (!response.delta) {
        if (response.config) config.value = response.config
        if (response.models) models.value = Object.values(response.models)
        if (response.vocabulary !== undefined) vocabulary.value = response.vocabulary
        if (response.contentContext !== undefined) contentContext.value = response.contentContext
        if (response.contentSummary) contentSummary.value = response.contentSummary
        if (response.schemaValidation !== undefined) schemaValidation.value = response.schemaValidation
        // Store content in memory for instant queryContent access
        if (response.content) {
          for (const [key, value] of Object.entries(response.content)) {
            sharedContentStore.set(key, value as { data: unknown, meta: Record<string, unknown> | null, kind: string })
          }
        }
        networkApplied = true
      }
      else if (!config.value && sharedWorker && sharedProjectId) {
        // An empty delta says "you already have it" — and it is in IndexedDB.
        // `ready` normally delivered it already; this covers any path where it
        // did not, rather than leave the project looking uninitialised.
        sharedWorker.postMessage({ type: 'getSnapshot', projectId: sharedProjectId })
      }

      treeSha.value = response.treeSha
      ready.value = true
      syncing.value = false
    }
    catch {
      const { t } = useContent()
      syncError.value = t('content.sync_error')
      syncing.value = false

      // If brain sync fails, request snapshot from worker cache (if available)
      if (sharedWorker && sharedProjectId) {
        sharedWorker.postMessage({ type: 'getSnapshot', projectId: sharedProjectId })
      }
    }
  }

  async function invalidate(projectId: string) {
    if (sharedWorker) {
      sharedWorker.postMessage({ type: 'invalidate', projectId })
    }
    // Also invalidate server-side via query param trick (next sync will rebuild)
    treeSha.value = null
    ready.value = false
    sharedContentStore.clear()
  }

  // --- Query ---

  async function queryContent(modelId: string, locale: string): Promise<ContentQueryResult> {
    // 1. In-memory store (instant — populated from sync response)
    const key = `${modelId}:${locale}`
    const cached = sharedContentStore.get(key)
    if (cached) {
      return { data: cached.data, kind: cached.kind, meta: cached.meta }
    }

    // 2. Worker IndexedDB (if available)
    if (sharedWorker && sharedProjectId) {
      return new Promise((resolve) => {
        const id = `query-${++requestCounter}`
        pendingRequests.set(id, {
          resolve: data => resolve(data as ContentQueryResult),
          reject: () => resolve({ data: null, kind: 'collection', meta: null }),
        })
        sharedWorker!.postMessage({ type: 'query', id, modelId, locale, projectId: sharedProjectId })

        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id)
            resolve({ data: null, kind: 'collection', meta: null })
          }
        }, 5000)
      })
    }

    // 3. No data available
    return { data: null, kind: 'collection', meta: null }
  }

  /**
   * Full-text search over the brain's index.
   *
   * `locale` matters: the index is keyed per locale, so a search that omits it
   * returns English hits to someone reading the Turkish list.
   */
  async function searchContent(
    query: string,
    options: { modelId?: string, locale?: string, limit?: number } = {},
  ): Promise<SearchResult[]> {
    if (!sharedWorker) return []

    const { modelId, locale, limit } = options

    return new Promise((resolve) => {
      const id = `search-${++requestCounter}`
      pendingRequests.set(id, {
        resolve: data => resolve((data ?? []) as SearchResult[]),
        reject: () => resolve([]),
      })
      sharedWorker!.postMessage({ type: 'search', id, query, modelId, locale, limit: limit ?? 10 })

      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id)
          resolve([])
        }
      }, 5000)
    })
  }

  // --- Computed ---

  const modelList = computed(() => models.value)
  const hasContentrain = computed(() => config.value !== null)

  /**
   * Whether a search can currently answer.
   *
   * `searchContent` resolves to `[]` when there is no worker, which is
   * indistinguishable from "nothing matched" — and telling someone their query
   * found nothing when nothing was searched is worse than saying so.
   */
  const searchReady = computed(() => workerAvailable.value && ready.value)
  const projectStats = computed(() => {
    const ctx = contentContext.value as { stats?: { models?: number, entries?: number, locales?: string[] } } | null
    if (!config.value) return null
    return {
      modelCount: ctx?.stats?.models ?? models.value.length,
      entryCount: ctx?.stats?.entries ?? Object.values(contentSummary.value).reduce((sum, s) => sum + s.count, 0),
      localeCount: ctx?.stats?.locales?.length ?? 0,
      locales: ctx?.stats?.locales ?? [],
    }
  })

  return {
    // State
    treeSha: readonly(treeSha),
    syncing: readonly(syncing),
    ready: readonly(ready),
    searchReady,
    syncError: readonly(syncError),
    config: readonly(config),
    models: readonly(models),
    modelList,
    vocabulary: readonly(vocabulary),
    contentContext: readonly(contentContext),
    contentSummary: readonly(contentSummary),
    schemaValidation: readonly(schemaValidation),
    hasContentrain,
    projectStats,

    // Actions
    initBrain,
    destroyBrain,
    sync,
    invalidate,
    queryContent,
    searchContent,
  }
}
