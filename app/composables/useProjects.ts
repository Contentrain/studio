interface Project {
  id: string
  owner_id: string
  provider: string
  repo_full_name: string
  default_branch: string
  content_root: string
  detected_stack: string | null
  github_installation_id: number | null
  status: string
  created_at: string
}

export function useProjects() {
  const projects = useState<Project[]>('projects', () => [])
  const loading = useState('projects-loading', () => false)
  const { apiFetch } = useApi()

  async function fetchProjects() {
    loading.value = true
    try {
      projects.value = await apiFetch<Project[]>('/api/projects')
    }
    finally {
      loading.value = false
    }
  }

  async function createProject(data: {
    repoFullName: string
    defaultBranch?: string
    contentRoot?: string
    detectedStack?: string
    githubInstallationId?: number
  }) {
    const project = await apiFetch<Project>('/api/projects', {
      method: 'POST',
      body: data,
    })
    projects.value.unshift(project)
    return project
  }

  return {
    projects: readonly(projects),
    loading: readonly(loading),
    fetchProjects,
    createProject,
  }
}
