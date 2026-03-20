import { get, set } from 'idb-keyval'

interface CachedModelContent {
  data: unknown
  kind: string
  timestamp: number
}

const CACHE_PREFIX = 'cr-content-'
const STALE_MS = 5 * 60 * 1000 // 5 minutes

// In-memory cache for instant switching between models
const memoryCache = new Map<string, CachedModelContent>()

export function useModelContent() {
  const content = useState<unknown>('model-content', () => null)
  const kind = useState<string>('model-content-kind', () => 'collection')
  const loading = useState('model-content-loading', () => false)

  async function fetchContent(workspaceId: string, projectId: string, modelId: string) {
    const cacheKey = `${CACHE_PREFIX}${projectId}:${modelId}`

    // 1. Memory cache (instant)
    const mem = memoryCache.get(cacheKey)
    if (mem && Date.now() - mem.timestamp < STALE_MS) {
      content.value = mem.data
      kind.value = mem.kind
      return
    }

    // 2. IndexedDB cache (fast, survives refresh)
    if (import.meta.client) {
      try {
        const cached = await get<CachedModelContent>(cacheKey)
        if (cached && Date.now() - cached.timestamp < STALE_MS) {
          content.value = cached.data
          kind.value = cached.kind
          memoryCache.set(cacheKey, cached)
          return
        }
      }
      catch { /* IndexedDB unavailable */ }
    }

    // 3. API fetch (slow — GitHub API)
    loading.value = true
    try {
      const result = await $fetch<{ data: unknown, kind?: string }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/content/${modelId}`,
      )
      content.value = result.data
      kind.value = result.kind ?? 'collection'

      // Cache in memory + IndexedDB
      const entry: CachedModelContent = {
        data: result.data,
        kind: result.kind ?? 'collection',
        timestamp: Date.now(),
      }
      memoryCache.set(cacheKey, entry)

      if (import.meta.client) {
        try {
          await set(cacheKey, entry)
        }
        catch {
          // IndexedDB write not critical
        }
      }
    }
    catch {
      content.value = null
    }
    finally {
      loading.value = false
    }
  }

  function clearContent() {
    content.value = null
    kind.value = 'collection'
  }

  return {
    content: readonly(content),
    kind: readonly(kind),
    loading: readonly(loading),
    fetchContent,
    clearContent,
  }
}
