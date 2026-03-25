import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjects } from '../../../app/composables/useProjects'

describe('useProjects', () => {
  beforeEach(() => {
    useState('projects').value = []
    useState('projects-loading').value = false
  })

  it('loads projects for the selected workspace', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([
      {
        id: 'project-1',
        workspace_id: 'workspace-1',
        repo_full_name: 'contentrain/studio',
        default_branch: 'main',
        content_root: '',
        detected_stack: 'nuxt',
        status: 'active',
        created_at: '2026-03-25T00:00:00.000Z',
      },
    ]))

    const projects = useProjects()
    await projects.fetchProjects('workspace-1')

    expect(projects.loading.value).toBe(false)
    expect(projects.projects.value).toHaveLength(1)
    expect(projects.projects.value[0]?.repo_full_name).toBe('contentrain/studio')
  })

  it('prepends newly created projects to local state', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      id: 'project-2',
      workspace_id: 'workspace-1',
      repo_full_name: 'contentrain/docs',
      default_branch: 'main',
      content_root: 'apps/docs',
      detected_stack: 'nuxt',
      status: 'active',
      created_at: '2026-03-25T00:00:00.000Z',
    }))
    useState('projects').value = [
      {
        id: 'project-1',
        workspace_id: 'workspace-1',
        repo_full_name: 'contentrain/studio',
        default_branch: 'main',
        content_root: '',
        detected_stack: 'nuxt',
        status: 'active',
        created_at: '2026-03-24T00:00:00.000Z',
      },
    ]

    const projects = useProjects()
    await projects.createProject('workspace-1', {
      repoFullName: 'contentrain/docs',
      contentRoot: 'apps/docs',
      detectedStack: 'nuxt',
    })

    expect(projects.projects.value.map(project => project.id)).toEqual(['project-2', 'project-1'])
  })
})
