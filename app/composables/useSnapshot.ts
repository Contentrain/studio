import type { ModelKind } from '@contentrain/types'
import { get, set, del } from 'idb-keyval'

interface ModelSummary {
  id: string
  name: string
  kind: ModelKind
  type: ModelKind
  fields: Record<string, unknown>
  domain: string
  i18n: boolean
}

interface ContentSummary {
  count: number
  locales: string[]
}

interface ContentContext {
  lastOperation?: { tool?: string, model?: string, locale?: string, timestamp?: string }
  stats?: { models?: number, entries?: number, locales?: string[] }
}

interface Snapshot {
  exists: boolean
  config: unknown
  models: ModelSummary[]
  content: Record<string, ContentSummary>
  vocabulary?: Record<string, Record<string, string>> | null
  contentContext?: ContentContext | null
}

interface CachedSnapshot {
  data: Snapshot
  timestamp: number
  projectId: string
}

const CACHE_PREFIX = 'cr-snapshot-'
const STALE_AFTER_MS = 5 * 60 * 1000 // 5 minutes — show cache, refresh in background

export function useSnapshot() {
  const snapshot = useState<Snapshot | null>('snapshot', () => null)
  const loading = useState('snapshot-loading', () => false)
  const refreshing = useState('snapshot-refreshing', () => false)
  const error = useState<string | null>('snapshot-error', () => null)

  /**
   * Load snapshot with cache-first strategy:
   * 1. Read from IndexedDB → instant render
   * 2. If stale or no cache → fetch from API in background
   * 3. Update IndexedDB + reactive state
   */
  async function fetchSnapshot(workspaceId: string, projectId: string) {
    error.value = null
    const cacheKey = `${CACHE_PREFIX}${projectId}`

    // 1. Try IndexedDB cache first (client only)
    if (import.meta.client) {
      try {
        const cached = await get<CachedSnapshot>(cacheKey)
        if (cached && cached.projectId === projectId) {
          snapshot.value = cached.data
          // If cache is fresh enough, skip API call
          const age = Date.now() - cached.timestamp
          if (age < STALE_AFTER_MS) {
            return
          }
          // Cache is stale — show it but refresh in background
          refreshing.value = true
          fetchFromAPI(workspaceId, projectId, cacheKey).finally(() => {
            refreshing.value = false
          })
          return
        }
      }
      catch {
        // IndexedDB unavailable — fall through to API
      }
    }

    // 2. No cache — show loading, fetch from API
    loading.value = true
    await fetchFromAPI(workspaceId, projectId, cacheKey)
    loading.value = false
  }

  async function fetchFromAPI(workspaceId: string, projectId: string, cacheKey: string) {
    try {
      const data = await $fetch<Snapshot>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/snapshot`,
      )
      snapshot.value = data

      // Write to IndexedDB cache
      if (import.meta.client) {
        try {
          await set(cacheKey, {
            data,
            timestamp: Date.now(),
            projectId,
          } satisfies CachedSnapshot)
        }
        catch {
          // IndexedDB write failed — not critical
        }
      }
    }
    catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to load content'
      // Don't clear snapshot if we have cached data
      if (!snapshot.value)
        snapshot.value = null
    }
  }

  function clearSnapshot() {
    snapshot.value = null
    error.value = null
  }

  /**
   * Invalidate cache for a project (call after content changes).
   */
  async function invalidateCache(projectId: string) {
    if (import.meta.client) {
      try {
        await del(`${CACHE_PREFIX}${projectId}`)
      }
      catch {
        // Not critical
      }
    }
  }

  const models = computed(() => snapshot.value?.models ?? [])
  const hasContentrain = computed(() => snapshot.value?.exists ?? false)
  const vocabulary = computed(() => snapshot.value?.vocabulary ?? null)
  const contentContext = computed(() => snapshot.value?.contentContext ?? null)
  const projectStats = computed(() => {
    if (!snapshot.value?.exists) return null
    const ctx = snapshot.value.contentContext?.stats
    return {
      modelCount: ctx?.models ?? snapshot.value.models.length,
      entryCount: ctx?.entries ?? Object.values(snapshot.value.content).reduce((sum, c) => sum + c.count, 0),
      localeCount: ctx?.locales?.length ?? 0,
      locales: ctx?.locales ?? [],
    }
  })

  return {
    snapshot: readonly(snapshot),
    models,
    hasContentrain,
    vocabulary,
    contentContext,
    projectStats,
    loading: readonly(loading),
    refreshing: readonly(refreshing),
    error: readonly(error),
    fetchSnapshot,
    clearSnapshot,
    invalidateCache,
  }
}
