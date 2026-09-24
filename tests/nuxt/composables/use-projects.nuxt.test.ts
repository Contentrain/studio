import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjects } from '../../../app/composables/useProjects'

describe('useProjects', () => {
  beforeEach(() => {
    useState('projects').value = []
    useState('projects-loading').value = false
    useState('projects-workspace').value = null
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

  describe('ensureProjects — the sidebar on a page that does not load the list', () => {
    const row = (id: string, workspaceId: string) => ({ id, workspace_id: workspaceId, repo_full_name: `org/${id}`, default_branch: 'main', content_root: '', detected_stack: null, status: 'active', created_at: '2026-09-24T00:00:00.000Z' })

    it('loads the list on a direct entry and does not load it again for the same workspace', async () => {
      const fetch = vi.fn().mockResolvedValue([row('p1', 'ws-1'), row('p2', 'ws-1')])
      vi.stubGlobal('$fetch', fetch)
      const projects = useProjects()
      await projects.ensureProjects('ws-1')
      await projects.ensureProjects('ws-1')
      expect(projects.projects.value.map(p => p.id)).toEqual(['p1', 'p2'])
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('joins the page\'s request instead of sending a second one', async () => {
      let resolve!: (v: unknown) => void
      const fetch = vi.fn(() => new Promise((r) => {
        resolve = r
      }))
      vi.stubGlobal('$fetch', fetch)
      const projects = useProjects()
      const page = projects.fetchProjects('ws-1')
      const sidebar = projects.ensureProjects('ws-1')
      resolve([row('p1', 'ws-1')])
      await Promise.all([page, sidebar])
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(projects.projects.value.map(p => p.id)).toEqual(['p1'])
    })

    it('replaces another workspace\'s list, and a slower answer for the old one does not come back', async () => {
      const pending: Record<string, (v: unknown) => void> = {}
      vi.stubGlobal('$fetch', vi.fn((url: string) => new Promise((r) => {
        pending[url] = r
      })))
      const projects = useProjects()
      const left = projects.fetchProjects('ws-1')
      const entered = projects.ensureProjects('ws-2')
      pending['/api/workspaces/ws-2/projects']!([row('b1', 'ws-2')])
      await entered
      pending['/api/workspaces/ws-1/projects']!([row('a1', 'ws-1')])
      await left
      expect(projects.projects.value.map(p => p.id)).toEqual(['b1'])
      expect(projects.loading.value).toBe(false)
    })

    it('a forced refresh after a write sends its own request, and its answer wins', async () => {
      const pending: Array<(v: unknown) => void> = []
      vi.stubGlobal('$fetch', vi.fn(() => new Promise((r) => {
        pending.push(r)
      })))
      const projects = useProjects()
      const before = projects.ensureProjects('ws-1')
      const after = projects.fetchProjects('ws-1', { force: true })
      expect(pending).toHaveLength(2)
      pending[1]!([row('new', 'ws-1'), row('p1', 'ws-1')])
      await after
      pending[0]!([row('p1', 'ws-1')])
      await before
      expect(projects.projects.value.map(p => p.id)).toEqual(['new', 'p1'])
      expect(projects.loading.value).toBe(false)
    })

    it('tries again after a failed load', async () => {
      const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([row('p1', 'ws-1')])
      vi.stubGlobal('$fetch', fetch)
      const projects = useProjects()
      await expect(projects.ensureProjects('ws-1')).rejects.toThrow('offline')
      await projects.ensureProjects('ws-1')
      expect(projects.projects.value.map(p => p.id)).toEqual(['p1'])
    })
  })
})
