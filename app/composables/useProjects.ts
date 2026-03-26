interface Project {
  id: string
  workspace_id: string
  repo_full_name: string
  default_branch: string
  content_root: string
  detected_stack: string | null
  status: string
  created_at: string
}

export function useProjects() {
  const projects = useState<Project[]>('projects', () => [])
  const loading = useState('projects-loading', () => false)

  async function fetchProjects(workspaceId: string) {
    loading.value = true
    try {
      projects.value = await $fetch<Project[]>(`/api/workspaces/${workspaceId}/projects`)
    }
    finally {
      loading.value = false
    }
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
    createProject,
    deleteProject,
  }
}
