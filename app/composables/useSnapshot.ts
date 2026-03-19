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

interface Snapshot {
  exists: boolean
  config: unknown
  models: ModelSummary[]
  content: Record<string, ContentSummary>
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

  return {
    snapshot: readonly(snapshot),
    models,
    hasContentrain,
    loading: readonly(loading),
    refreshing: readonly(refreshing),
    error: readonly(error),
    fetchSnapshot,
    clearSnapshot,
    invalidateCache,
  }
}
