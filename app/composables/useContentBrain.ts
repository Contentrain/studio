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

interface BrainSyncResponse {
  treeSha: string
  delta: boolean
  config: ContentrainConfig | null
  models: Record<string, ModelDefinition> | null
  content: Record<string, { data: unknown, meta: Record<string, unknown> | null, kind: string }> | null
  vocabulary: Record<string, Record<string, string>> | null
  contentContext: Record<string, unknown> | null
  contentSummary: Record<string, { count: number, locales: string[], kind: ModelKind }> | null
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

// Pending promise resolvers for Worker query/search responses
const pendingRequests = new Map<string, { resolve: (value: unknown) => void, reject: (reason: unknown) => void }>()
let requestCounter = 0

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

  let worker: Worker | null = null
  let currentProjectId: string | null = null

  // --- Worker Lifecycle ---

  function initBrain(projectId: string) {
    if (!import.meta.client) return

    // If already initialized for this project, skip
    if (worker && currentProjectId === projectId) return

    // Destroy previous worker if switching projects
    if (worker) destroyBrain()

    currentProjectId = projectId

    try {
      worker = new Worker(
        new URL('~/workers/content-brain.worker.ts', import.meta.url),
        { type: 'module' },
      )
      worker.onmessage = handleWorkerMessage
      worker.postMessage({ type: 'init', projectId })
    }
    catch {
      // Worker creation failed — fallback to API-only mode
      worker = null
    }
  }

  function destroyBrain() {
    if (worker) {
      worker.postMessage({ type: 'destroy' })
      worker.terminate()
      worker = null
    }
    currentProjectId = null
    ready.value = false
    treeSha.value = null
    config.value = null
    models.value = []
    vocabulary.value = null
    contentContext.value = null
    contentSummary.value = {}
    pendingRequests.clear()
  }

  // --- Worker Message Handler ---

  function handleWorkerMessage(event: MessageEvent) {
    const msg = event.data

    switch (msg.type) {
      case 'ready':
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
        if (worker && currentProjectId) {
          worker.postMessage({ type: 'getSnapshot', projectId: currentProjectId })
        }
        break

      case 'invalidated':
        ready.value = false
        break

      case 'error':
        syncError.value = msg.message
        syncing.value = false
        break
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
      if (worker) {
        worker.postMessage({ type: 'sync', payload: response, projectId })
      }

      // Update reactive state from response (immediate, don't wait for worker)
      if (!response.delta) {
        if (response.config) config.value = response.config
        if (response.models) models.value = Object.values(response.models)
        if (response.vocabulary !== undefined) vocabulary.value = response.vocabulary
        if (response.contentContext !== undefined) contentContext.value = response.contentContext
        if (response.contentSummary) contentSummary.value = response.contentSummary
      }

      treeSha.value = response.treeSha
      ready.value = true
      syncing.value = false
    }
    catch (e: unknown) {
      syncError.value = e instanceof Error ? e.message : 'Brain sync failed'
      syncing.value = false

      // If brain sync fails, request snapshot from worker cache (if available)
      if (worker && currentProjectId) {
        worker.postMessage({ type: 'getSnapshot', projectId: currentProjectId })
      }
    }
  }

  async function invalidate(projectId: string) {
    if (worker) {
      worker.postMessage({ type: 'invalidate', projectId })
    }
    // Also invalidate server-side via query param trick (next sync will rebuild)
    treeSha.value = null
    ready.value = false
  }

  // --- Query ---

  async function queryContent(modelId: string, locale: string): Promise<ContentQueryResult> {
    if (!worker || !currentProjectId) {
      // Fallback: direct API call
      const result = await $fetch<ContentQueryResult>(
        `/api/workspaces/${currentProjectId}/projects/${currentProjectId}/content/${modelId}`,
        { params: { locale } },
      )
      return result
    }

    return new Promise((resolve, reject) => {
      const id = `query-${++requestCounter}`
      pendingRequests.set(id, {
        resolve: data => resolve(data as ContentQueryResult),
        reject,
      })
      worker!.postMessage({ type: 'query', id, modelId, locale, projectId: currentProjectId })

      // Timeout after 5 seconds — fallback to no-data
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id)
          resolve({ data: null, kind: 'collection', meta: null })
        }
      }, 5000)
    })
  }

  async function searchContent(query: string, modelId?: string, limit?: number): Promise<SearchResult[]> {
    if (!worker) return []

    return new Promise((resolve) => {
      const id = `search-${++requestCounter}`
      pendingRequests.set(id, {
        resolve: data => resolve((data ?? []) as SearchResult[]),
        reject: () => resolve([]),
      })
      worker!.postMessage({ type: 'search', id, query, modelId, limit: limit ?? 10 })

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
