interface ModelSummary {
  id: string
  name: string
  type: string
  fields: unknown[]
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

export function useSnapshot() {
  const snapshot = useState<Snapshot | null>('snapshot', () => null)
  const loading = useState('snapshot-loading', () => false)
  const error = useState<string | null>('snapshot-error', () => null)

  async function fetchSnapshot(workspaceId: string, projectId: string) {
    loading.value = true
    error.value = null
    try {
      snapshot.value = await $fetch<Snapshot>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/snapshot`,
      )
    }
    catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to load content'
      snapshot.value = null
    }
    finally {
      loading.value = false
    }
  }

  function clearSnapshot() {
    snapshot.value = null
    error.value = null
  }

  const models = computed(() => snapshot.value?.models ?? [])
  const hasContentrain = computed(() => snapshot.value?.exists ?? false)

  return {
    snapshot: readonly(snapshot),
    models,
    hasContentrain,
    loading: readonly(loading),
    error: readonly(error),
    fetchSnapshot,
    clearSnapshot,
  }
}
