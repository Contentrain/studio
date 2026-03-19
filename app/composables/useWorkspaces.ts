interface Workspace {
  id: string
  name: string
  slug: string
  type: 'primary' | 'secondary'
  owner_id: string
  logo_url: string | null
  github_installation_id: number | null
  plan: string
  created_at: string
}

export function useWorkspaces() {
  const workspaces = useState<Workspace[]>('workspaces', () => [])
  const loading = useState('workspaces-loading', () => false)

  const activeWorkspaceId = useState<string | null>('active-workspace-id', () => null)

  const activeWorkspace = computed(() =>
    workspaces.value.find(w => w.id === activeWorkspaceId.value) ?? null,
  )

  async function fetchWorkspaces() {
    loading.value = true
    try {
      workspaces.value = await $fetch<Workspace[]>('/api/workspaces')
      // Auto-select primary workspace if none selected
      if (!activeWorkspaceId.value && workspaces.value.length > 0) {
        const primary = workspaces.value.find(w => w.type === 'primary')
        activeWorkspaceId.value = primary?.id ?? workspaces.value[0].id
      }
    }
    finally {
      loading.value = false
    }
  }

  function setActiveWorkspace(id: string) {
    activeWorkspaceId.value = id
  }

  async function createWorkspace(data: { name: string, slug: string }) {
    const workspace = await $fetch<Workspace>('/api/workspaces', {
      method: 'POST',
      body: data,
    })
    workspaces.value.push(workspace)
    return workspace
  }

  return {
    workspaces: readonly(workspaces),
    activeWorkspace,
    loading: readonly(loading),
    fetchWorkspaces,
    setActiveWorkspace,
    createWorkspace,
  }
}
