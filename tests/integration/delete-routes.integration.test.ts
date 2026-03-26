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
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('owner'))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table !== 'workspaces')
          throw new Error(`Unexpected table: ${table}`)

        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: { id: 'workspace-primary', type: 'primary', owner_id: 'owner-1' },
              }),
            })),
          })),
        }
      }),
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
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('owner'))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({ deletePrefix }))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'workspace-1', type: 'secondary', owner_id: 'owner-1' },
                }),
              })),
            })),
            delete: vi.fn(() => ({
              eq: deleteEq,
            })),
          }
        }

        if (table === 'projects') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({
                data: [{ id: 'project-1' }, { id: 'project-2' }],
              }),
            })),
          }
        }

        throw new Error(`Unexpected table: ${table}`)
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
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('admin'))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table !== 'projects')
          throw new Error(`Unexpected table: ${table}`)

        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ data: null }),
              })),
            })),
          })),
        }
      }),
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
    const rpc = vi.fn().mockResolvedValue({ error: null })
    const deleteProject = vi.fn().mockResolvedValue({ error: null })

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'admin-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('admin'))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({ deletePrefix }))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({
      rpc,
      from: vi.fn((table: string) => {
        if (table === 'projects') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn().mockResolvedValue({ data: { id: 'project-1' } }),
                })),
              })),
            })),
            delete: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: deleteProject,
              })),
            })),
          }
        }

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
      expect(rpc).toHaveBeenCalledWith('decrement_storage_bytes', {
        ws_id: 'workspace-1',
        bytes: 2048,
      })
    })
  })
})
