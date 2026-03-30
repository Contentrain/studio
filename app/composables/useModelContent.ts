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
      const result = await brain.queryContent(modelId, locale)
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
        content.value = null
      }
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
