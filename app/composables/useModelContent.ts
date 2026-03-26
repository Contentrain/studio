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

export function useModelContent() {
  const brain = useContentBrain()

  const content = useState<unknown>('model-content', () => null)
  const kind = useState<string>('model-content-kind', () => 'collection')
  const meta = useState<Record<string, unknown> | null>('model-content-meta', () => null)
  const loading = useState('model-content-loading', () => false)

  async function fetchContent(workspaceId: string, projectId: string, modelId: string, locale: string = 'en') {
    loading.value = true
    try {
      if (brain.ready.value) {
        // Brain is ready — query from Worker IndexedDB (instant)
        const result = await brain.queryContent(modelId, locale)
        content.value = result.data
        kind.value = result.kind ?? 'collection'
        meta.value = (result.meta ?? null) as Record<string, unknown> | null
      }
      else {
        // Brain not ready — fallback to direct API
        const result = await $fetch<{ data: unknown, kind?: string, meta?: Record<string, unknown> | null }>(
          `/api/workspaces/${workspaceId}/projects/${projectId}/content/${modelId}`,
          { params: { locale } },
        )
        content.value = result.data
        kind.value = result.kind ?? 'collection'
        meta.value = result.meta ?? null
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
    clearContent,
    invalidateProjectContent,
  }
}
