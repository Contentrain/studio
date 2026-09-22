/**
 * Model content composable — thin adapter over Content Brain.
 *
 * Preserves the exact same return shape as the original useModelContent()
 * so all consuming components (ContentPanel, ContentCollectionView, etc.)
 * continue working without changes.
 *
 * Data source: useContentBrain().queryContent() → Worker IndexedDB
 * Fallback: direct API call if Brain not ready
 */

interface ContentRequest {
  workspaceId: string
  projectId: string
  modelId: string
  locale: string
}

/**
 * Bumped by every fetch. Only the newest one writes its answer: a model opened
 * from the cache while the sync runs is read out of IndexedDB, and that answer
 * can arrive after the fresh one the sync brought.
 */
let latestFetch = 0

export function useModelContent() {
  const brain = useContentBrain()

  const content = useState<unknown>('model-content', () => null)
  const kind = useState<string>('model-content-kind', () => 'collection')
  const meta = useState<Record<string, unknown> | null>('model-content-meta', () => null)
  const loading = useState('model-content-loading', () => false)
  // What is on screen, so a newer tree can be read into it again.
  const request = useState<ContentRequest | null>('model-content-request', () => null)

  async function fetchContent(workspaceId: string, projectId: string, modelId: string, locale: string = 'en') {
    const fetchId = ++latestFetch
    request.value = { workspaceId, projectId, modelId, locale }
    loading.value = true
    try {
      const result = await brain.queryContent(modelId, locale)
      if (fetchId !== latestFetch) return
      content.value = result.data
      kind.value = result.kind ?? 'collection'
      meta.value = (result.meta ?? null) as Record<string, unknown> | null
    }
    catch {
      // Brain not ready — fallback to server API (brain sync without treeSha = full payload)
      try {
        const syncResponse = await $fetch<{
          content: Record<string, { data: unknown, meta: Record<string, unknown> | null, kind: string }> | null
        }>(`/api/workspaces/${workspaceId}/projects/${projectId}/brain/sync`)
        if (fetchId !== latestFetch) return

        const key = `${modelId}:${locale}`
        const modelContent = syncResponse?.content?.[key]
        if (modelContent) {
          content.value = modelContent.data
          kind.value = modelContent.kind ?? 'collection'
          meta.value = (modelContent.meta ?? null) as Record<string, unknown> | null
        }
        else {
          content.value = null
        }
      }
      catch {
        if (fetchId === latestFetch) content.value = null
      }
    }
    finally {
      if (fetchId === latestFetch) loading.value = false
    }
  }

  /**
   * Read the open model again whenever the brain moves to another tree. With a
   * cache on screen the sidebar is usable before the sync answers; a model
   * opened in that window shows the cached tree until something re-reads it.
   * Call once, from the page that owns the open model.
   */
  function followTreeChanges() {
    watch(brain.treeSha, (sha, previous) => {
      const open = request.value
      if (!sha || sha === previous || !open) return
      void fetchContent(open.workspaceId, open.projectId, open.modelId, open.locale)
    })
  }

  function clearContent() {
    // A fetch still in flight is for what is being cleared; it must not land.
    latestFetch++
    request.value = null
    loading.value = false
    content.value = null
    kind.value = 'collection'
    meta.value = null
  }

  async function invalidateProjectContent(projectId: string) {
    await brain.invalidate(projectId)
    content.value = null
  }

  return {
    content: readonly(content),
    kind: readonly(kind),
    meta: readonly(meta),
    loading: readonly(loading),
    fetchContent,
    followTreeChanges,
    clearContent,
    invalidateProjectContent,
  }
}
