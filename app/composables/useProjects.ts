interface Project {
  id: string
  workspace_id: string
  repo_full_name: string
  default_branch: string
  content_root: string
  detected_stack: string | null
  status: string
  /**
   * Repo-level access state on GitHub's side, separate from the setup-
   * lifecycle `status` field above. Set by webhook handlers
   * (`installation_repositories.removed` / `repository.deleted`) and
   * reflected in the project page banner + sidebar badge.
   */
  access_status?: 'accessible' | 'inaccessible' | 'deleted'
  created_at: string
}

// The request in flight, shared by every caller (the app is client-only, so
// module state is per tab). The sidebar and the page both ask for the list on
// the same navigation; the second ask joins the first instead of repeating it.
let inflight: { workspaceId: string, promise: Promise<void> } | null = null

export function useProjects() {
  const projects = useState<Project[]>('projects', () => [])
  const loading = useState('projects-loading', () => false)
  /** The workspace `projects` was loaded for; null until the first load. */
  const loadedFor = useState<string | null>('projects-workspace', () => null)

  async function fetchProjects(workspaceId: string) {
    if (inflight?.workspaceId === workspaceId) return inflight.promise
    loading.value = true
    const request = (async () => {
      const list = await $fetch<Project[]>(`/api/workspaces/${workspaceId}/projects`)
      // A slower answer for the workspace we just left must not replace this one.
      if (inflight?.promise !== request) return
      projects.value = list
      loadedFor.value = workspaceId
    })()
    inflight = { workspaceId, promise: request }
    try {
      await request
    }
    finally {
      if (inflight?.promise === request) {
        inflight = null
        loading.value = false
      }
    }
  }

  /**
   * Load the list unless it is already this workspace's. Only the workspace
   * and project pages used to load it, so a page opened directly under the
   * workspace (settings) showed the sidebar with no projects, or with the
   * previous workspace's.
   */
  async function ensureProjects(workspaceId: string) {
    if (loadedFor.value === workspaceId) return
    return fetchProjects(workspaceId)
  }

  async function createProject(workspaceId: string, data: {
    repoFullName: string
    defaultBranch?: string
    contentRoot?: string
    detectedStack?: string
  }) {
    const project = await $fetch<Project>(`/api/workspaces/${workspaceId}/projects`, {
      method: 'POST',
      body: data,
    })
    projects.value.unshift(project)
    return project
  }

  async function deleteProject(workspaceId: string, projectId: string): Promise<boolean> {
    try {
      await $fetch(`/api/workspaces/${workspaceId}/projects/${projectId}`, {
        method: 'DELETE',
      })
      projects.value = projects.value.filter(p => p.id !== projectId)
      return true
    }
    catch {
      return false
    }
  }

  return {
    projects: readonly(projects),
    loading: readonly(loading),
    fetchProjects,
    ensureProjects,
    createProject,
    deleteProject,
  }
}
