import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadWorkspaceDeleteHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/index.delete')).default
}

async function loadProjectDeleteHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/index.delete')).default
}

describe('workspace and project delete route integration', () => {
  it('blocks deletion of primary workspaces', async () => {
    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-primary'))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'owner-1' },
      accessToken: 'token-1',
    }))

    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
      getWorkspaceById: vi.fn().mockResolvedValue({
        id: 'workspace-primary',
        type: 'primary',
        owner_id: 'owner-1',
      }),
      listWorkspaceProjects: vi.fn().mockResolvedValue([]),
      getAdminClient: vi.fn(),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-primary', handler: await loadWorkspaceDeleteHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-primary', { method: 'DELETE' })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 400,
      })
    })
  })

  it('deletes a workspace after cleaning project storage and ignores storage cleanup failures', async () => {
    const deletePrefix = vi.fn()
      .mockRejectedValueOnce(new Error('r2 unavailable'))
      .mockResolvedValueOnce(undefined)
    const deleteEq = vi.fn().mockResolvedValue({ error: null })

    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'owner-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({ deletePrefix }))

    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
      getWorkspaceById: vi.fn().mockResolvedValue({
        id: 'workspace-1',
        type: 'secondary',
        owner_id: 'owner-1',
      }),
      listWorkspaceProjects: vi.fn().mockResolvedValue([
        { id: 'project-1' },
        { id: 'project-2' },
      ]),
      getAdminClient: vi.fn().mockReturnValue({
        from: vi.fn((table: string) => {
          if (table === 'workspaces') {
            return {
              delete: vi.fn(() => ({
                eq: deleteEq,
              })),
            }
          }
          throw new Error(`Unexpected table: ${table}`)
        }),
      }),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1', handler: await loadWorkspaceDeleteHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1', { method: 'DELETE' })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ deleted: true })
      expect(deletePrefix).toHaveBeenCalledTimes(2)
      expect(deleteEq).toHaveBeenCalledWith('id', 'workspace-1')
    })
  })

  it('returns 404 when deleting a project through the wrong workspace path', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-foreign'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'admin-1' },
      accessToken: 'token-1',
    }))

    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      requireWorkspaceRole: vi.fn().mockResolvedValue('admin'),
      getProjectForWorkspace: vi.fn().mockResolvedValue(null),
      getAdminClient: vi.fn(),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-foreign', handler: await loadProjectDeleteHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-foreign', { method: 'DELETE' })

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 404,
      })
    })
  })

  it('deletes a project and decrements workspace storage usage by uploaded media bytes', async () => {
    const deletePrefix = vi.fn().mockResolvedValue(undefined)
    const deleteProject = vi.fn().mockResolvedValue(undefined)
    const incrementWorkspaceStorageBytes = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'admin-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({ deletePrefix }))

    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      requireWorkspaceRole: vi.fn().mockResolvedValue('admin'),
      getProjectForWorkspace: vi.fn().mockResolvedValue({ id: 'project-1' }),
      deleteProject,
      incrementWorkspaceStorageBytes,
      getAdminClient: vi.fn().mockReturnValue({
        from: vi.fn((table: string) => {
          if (table === 'media_assets') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn().mockResolvedValue({
                  data: [{ size_bytes: 512 }, { size_bytes: 1536 }],
                }),
              })),
            }
          }
          throw new Error(`Unexpected table: ${table}`)
        }),
      }),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1', handler: await loadProjectDeleteHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1', { method: 'DELETE' })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ deleted: true })
      expect(deletePrefix).toHaveBeenCalledWith('project-1', '')
      expect(incrementWorkspaceStorageBytes).toHaveBeenCalledWith('workspace-1', -2048)
    })
  })
})
