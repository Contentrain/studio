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

export function useContentBrain() {
  const treeSha = useState<string | null>('brain-tree-sha', () => null)
  const syncing = useState('brain-syncing', () => false)
  const ready = useState('brain-ready', () => false)
  const syncError = useState<string | null>('brain-sync-error', () => null)
  const config = useState<ContentrainConfig | null>('brain-config', () => null)
  const models = useState<ModelDefinition[]>('brain-models', () => [])
  const vocabulary = useState<Record<string, Record<string, string>> | null>('brain-vocabulary', () => null)
  const contentContext = useState<Record<string, unknown> | null>('brain-content-context', () => null)
  const contentSummary = useState<Record<string, { count: number, locales: string[], kind: ModelKind }>>('brain-content-summary', () => ({}))
  const schemaValidation = useState<SchemaValidationResult | null>('brain-schema-validation', () => null)

  // --- Worker Lifecycle ---

  function initBrain(projectId: string) {
    if (!import.meta.client) return

    // If already initialized for this project, skip
    if (sharedWorker && sharedProjectId === projectId) return

    // Destroy previous worker if switching projects
    if (sharedWorker) destroyBrain()

    sharedProjectId = projectId

    try {
      sharedWorker = new ContentBrainWorker()
      sharedWorker.onmessage = handleWorkerMessage
      sharedWorker.onerror = (e) => {
        // eslint-disable-next-line no-console
        console.error('[brain] Worker error:', e.message)
      }
      // eslint-disable-next-line no-console
      console.log('[brain] Worker created successfully, sending init for project:', projectId)
      sharedWorker.postMessage({ type: 'init', projectId })
    }
    catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[brain] Worker creation failed, using in-memory only mode:', e)
      sharedWorker = null
    }
  }

  function destroyBrain() {
    if (sharedWorker) {
      sharedWorker.postMessage({ type: 'destroy' })
      sharedWorker.terminate()
      sharedWorker = null
    }
    sharedProjectId = null
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
        ready.value = !!msg.cached
        break

      case 'synced':
        treeSha.value = msg.treeSha
        syncing.value = false
        ready.value = true
        syncError.value = null
        break

      case 'snapshot':
        if (msg.data) {
          config.value = msg.data.config ?? null
          models.value = msg.data.models ?? []
          vocabulary.value = msg.data.vocabulary ?? null
          contentContext.value = msg.data.contentContext ?? null
          contentSummary.value = msg.data.content ?? {}
        }
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
        break
      }
    }
  }

  // --- Sync ---

  async function sync(workspaceId: string, projectId: string) {
    syncing.value = true
    syncError.value = null

    try {
      const params = new URLSearchParams()
      if (treeSha.value) params.set('treeSha', treeSha.value)

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

  async function searchContent(query: string, modelId?: string, limit?: number): Promise<SearchResult[]> {
    if (!sharedWorker) return []

    return new Promise((resolve) => {
      const id = `search-${++requestCounter}`
      pendingRequests.set(id, {
        resolve: data => resolve((data ?? []) as SearchResult[]),
        reject: () => resolve([]),
      })
      sharedWorker!.postMessage({ type: 'search', id, query, modelId, limit: limit ?? 10 })

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
