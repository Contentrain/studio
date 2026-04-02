import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceRole, useWorkspaces } from '../../../app/composables/useWorkspaces'

describe('useWorkspaces', () => {
  beforeEach(() => {
    localStorage.clear()
    useState('workspaces').value = []
    useState('workspaces-loading').value = false
    useState('active-workspace-id').value = null
  })

  it('restores the persisted workspace when it still exists', async () => {
    localStorage.setItem('cr-active-workspace', 'workspace-2')
    useState('active-workspace-id').value = 'workspace-2'
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([
      { id: 'workspace-1', name: 'Primary', slug: 'primary', type: 'primary', owner_id: 'user-1', logo_url: null, github_installation_id: null, plan: 'free', created_at: '2026-03-25T00:00:00.000Z' },
      { id: 'workspace-2', name: 'Team', slug: 'team', type: 'secondary', owner_id: 'user-1', logo_url: null, github_installation_id: null, plan: 'pro', created_at: '2026-03-25T00:00:00.000Z' },
    ]))

    const workspaces = useWorkspaces()
    await workspaces.fetchWorkspaces()

    expect(workspaces.activeWorkspace.value?.id).toBe('workspace-2')
  })

  it('falls back to the primary workspace when the persisted one no longer exists', async () => {
    localStorage.setItem('cr-active-workspace', 'missing-workspace')
    useState('active-workspace-id').value = 'missing-workspace'
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([
      { id: 'workspace-1', name: 'Primary', slug: 'primary', type: 'primary', owner_id: 'user-1', logo_url: null, github_installation_id: null, plan: 'free', created_at: '2026-03-25T00:00:00.000Z' },
      { id: 'workspace-2', name: 'Team', slug: 'team', type: 'secondary', owner_id: 'user-1', logo_url: null, github_installation_id: null, plan: 'pro', created_at: '2026-03-25T00:00:00.000Z' },
    ]))

    const workspaces = useWorkspaces()
    await workspaces.fetchWorkspaces()

    expect(workspaces.activeWorkspace.value?.id).toBe('workspace-1')
  })

  it('persists workspace selection and last path locally', () => {
    const workspaces = useWorkspaces()

    workspaces.setActiveWorkspace('workspace-9')
    workspaces.saveLastPath('/w/team/projects/project-1')

    expect(localStorage.getItem('cr-active-workspace')).toBe('workspace-9')
    expect(workspaces.getLastPath()).toBe('/w/team/projects/project-1')
  })

  it('derives owner or admin state from the active workspace membership', () => {
    useState('workspaces').value = [
      {
        id: 'workspace-1',
        name: 'Primary',
        slug: 'primary',
        type: 'primary',
        owner_id: 'user-1',
        logo_url: null,
        github_installation_id: null,
        plan: 'free',
        created_at: '2026-03-25T00:00:00.000Z',
        workspace_members: [{ role: 'admin' }],
      },
    ]
    useState('active-workspace-id').value = 'workspace-1'

    const { role, isOwnerOrAdmin } = useWorkspaceRole()

    expect(role.value).toBe('admin')
    expect(isOwnerOrAdmin.value).toBe(true)
  })
})
