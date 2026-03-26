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
  workspace_members?: Array<{ role: string }>
}

/** Get user's role in active workspace */
export function useWorkspaceRole() {
  const { activeWorkspace } = useWorkspaces()
  const role = computed(() => activeWorkspace.value?.workspace_members?.[0]?.role ?? 'member')
  const isOwnerOrAdmin = computed(() => role.value === 'owner' || role.value === 'admin')
  return { role, isOwnerOrAdmin }
}

const STORAGE_KEY_WORKSPACE = 'cr-active-workspace'
const STORAGE_KEY_LAST_PATH = 'cr-last-path'

export function useWorkspaces() {
  const workspaces = useState<Workspace[]>('workspaces', () => [])
  const loading = useState('workspaces-loading', () => false)

  const activeWorkspaceId = useState<string | null>('active-workspace-id', () => {
    if (import.meta.client) {
      return localStorage.getItem(STORAGE_KEY_WORKSPACE)
    }
    return null
  })

  const activeWorkspace = computed(() =>
    workspaces.value.find(w => w.id === activeWorkspaceId.value) ?? null,
  )

  async function fetchWorkspaces() {
    loading.value = true
    try {
      workspaces.value = await $fetch<Workspace[]>('/api/workspaces')
      // Restore persisted workspace, or fallback to primary
      if (activeWorkspaceId.value) {
        const exists = workspaces.value.some(w => w.id === activeWorkspaceId.value)
        if (!exists) activeWorkspaceId.value = null
      }
      if (!activeWorkspaceId.value && workspaces.value.length > 0) {
        const primary = workspaces.value.find(w => w.type === 'primary')
        activeWorkspaceId.value = primary?.id ?? workspaces.value[0]!.id
      }
    }
    finally {
      loading.value = false
    }
  }

  function setActiveWorkspace(id: string) {
    activeWorkspaceId.value = id
    if (import.meta.client) {
      localStorage.setItem(STORAGE_KEY_WORKSPACE, id)
    }
  }

  /**
   * Persist the current route path so user returns to last location.
   */
  function saveLastPath(path: string) {
    if (import.meta.client) {
      localStorage.setItem(STORAGE_KEY_LAST_PATH, path)
    }
  }

  /**
   * Get the last visited path (e.g., /w/contentrain/projects/abc-123).
   */
  function getLastPath(): string | null {
    if (import.meta.client) {
      return localStorage.getItem(STORAGE_KEY_LAST_PATH)
    }
    return null
  }

  async function createWorkspace(data: { name: string, slug: string }) {
    const workspace = await $fetch<Workspace>('/api/workspaces', {
      method: 'POST',
      body: data,
    })
    workspaces.value.push(workspace)
    return workspace
  }

  async function deleteWorkspace(workspaceId: string): Promise<boolean> {
    try {
      await $fetch(`/api/workspaces/${workspaceId}`, { method: 'DELETE' })
      workspaces.value = workspaces.value.filter(w => w.id !== workspaceId)
      // Reset active workspace to primary or first available
      if (activeWorkspaceId.value === workspaceId) {
        const primary = workspaces.value.find(w => w.type === 'primary')
        activeWorkspaceId.value = primary?.id ?? workspaces.value[0]?.id ?? null
        if (import.meta.client) {
          if (activeWorkspaceId.value) {
            localStorage.setItem(STORAGE_KEY_WORKSPACE, activeWorkspaceId.value)
          }
          else {
            localStorage.removeItem(STORAGE_KEY_WORKSPACE)
          }
          localStorage.removeItem(STORAGE_KEY_LAST_PATH)
        }
      }
      return true
    }
    catch {
      return false
    }
  }

  return {
    workspaces: readonly(workspaces),
    activeWorkspace,
    loading: readonly(loading),
    fetchWorkspaces,
    setActiveWorkspace,
    createWorkspace,
    deleteWorkspace,
    saveLastPath,
    getLastPath,
  }
}
