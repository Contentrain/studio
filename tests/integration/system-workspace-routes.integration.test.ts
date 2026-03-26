import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadHealthHandler() {
  return (await import('../../server/api/health.get')).default
}

async function loadWorkspaceGetHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/index.get')).default
}

async function loadWorkspacePatchHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/index.patch')).default
}

async function loadWorkspaceCreateHandler() {
  return (await import('../../server/api/workspaces/index.post')).default
}

async function loadWorkspaceMemberDeleteHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/members/[memberId].delete')).default
}

async function loadWorkspaceMemberPatchHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/members/[memberId].patch')).default
}

describe('system and workspace route integration', () => {
  it('returns a healthy timestamped status payload', async () => {
    await withTestServer({
      routes: [
        { path: '/api/health', handler: await loadHealthHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/health')
      const payload = await response.json()

      expect(response.status).toBe(200)
      expect(payload.status).toBe('ok')
      expect(Date.parse(payload.timestamp)).not.toBeNaN()
    })
  })

  it('loads workspace details with nested member profile data', async () => {
    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'workspace-1',
                name: 'Acme',
                workspace_members: [{ id: 'member-1', role: 'owner' }],
              },
              error: null,
            }),
          })),
        })),
      })),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1', handler: await loadWorkspaceGetHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1')

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        id: 'workspace-1',
        name: 'Acme',
        workspace_members: [{ id: 'member-1', role: 'owner' }],
      })
    })
  })

  it('normalizes workspace slugs on patch and returns 409 for collisions', async () => {
    const slugify = vi.fn().mockReturnValue('acme-studio')
    vi.stubGlobal('slugify', slugify)
    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))

    const client = {
      from: vi.fn(() => ({
        update: vi.fn(() => ({
          eq: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn()
                .mockResolvedValueOnce({
                  data: { id: 'workspace-1', name: 'Acme Studio', slug: 'acme-studio' },
                  error: null,
                })
                .mockResolvedValueOnce({
                  data: null,
                  error: { code: '23505', message: 'duplicate' },
                }),
            })),
          })),
        })),
      })),
    }
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue(client))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1', handler: await loadWorkspacePatchHandler() },
      ],
    }, async ({ request }) => {
      const success = await request('/api/workspaces/workspace-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Studio', slug: 'Acme Studio' }),
      })

      expect(success.status).toBe(200)
      await expect(success.json()).resolves.toEqual({
        id: 'workspace-1',
        name: 'Acme Studio',
        slug: 'acme-studio',
      })
      expect(slugify).toHaveBeenCalledWith('Acme Studio')

      const conflict = await request('/api/workspaces/workspace-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'Acme Studio' }),
      })

      expect(conflict.status).toBe(409)
    })
  })

  it('creates secondary workspaces when the plan limit allows it', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('slugify', vi.fn().mockReturnValue('acme-team'))
    vi.stubGlobal('listUserWorkspaces', vi.fn().mockResolvedValue([
      { id: 'ws-primary', plan: 'business' },
    ]))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('business'))
    vi.stubGlobal('getPlanLimit', vi.fn().mockReturnValue(5))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({
      from: vi.fn(() => ({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: { id: 'workspace-2', slug: 'acme-team', type: 'secondary' },
              error: null,
            }),
          })),
        })),
      })),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces', handler: await loadWorkspaceCreateHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Team', slug: 'Acme Team' }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        id: 'workspace-2',
        slug: 'acme-team',
        type: 'secondary',
      })
    })
  })

  it('blocks owner removal and allows member role updates by workspace owners', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'owner-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table !== 'workspace_members') throw new Error(`Unexpected table: ${table}`)

        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn()
                  .mockResolvedValueOnce({ data: { role: 'owner' } })
                  .mockResolvedValueOnce({ data: { role: 'member' } })
                  .mockResolvedValueOnce({ data: { role: 'member' } }),
              })),
            })),
          })),
          delete: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({ error: null }),
            })),
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'member-2', role: 'admin' },
                    error: null,
                  }),
                })),
              })),
            })),
          })),
        }
      }),
    }))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('owner'))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/members/member-1', handler: await loadWorkspaceMemberDeleteHandler() },
        { path: '/api/workspaces/workspace-1/members/member-2', handler: await loadWorkspaceMemberPatchHandler() },
      ],
    }, async ({ request }) => {
      vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
        if (key === 'workspaceId') return 'workspace-1'
        if (key === 'memberId') return 'member-1'
        return undefined
      }))

      const deleteOwner = await request('/api/workspaces/workspace-1/members/member-1', { method: 'DELETE' })
      expect(deleteOwner.status).toBe(400)

      vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
        if (key === 'workspaceId') return 'workspace-1'
        if (key === 'memberId') return 'member-2'
        return undefined
      }))

      const patchRole = await request('/api/workspaces/workspace-1/members/member-2', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      })

      expect(patchRole.status).toBe(200)
      await expect(patchRole.json()).resolves.toEqual({
        id: 'member-2',
        role: 'admin',
      })
    })
  })
})
