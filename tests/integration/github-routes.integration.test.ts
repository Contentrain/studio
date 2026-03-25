import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadSetupHandler() {
  return (await import('../../server/api/github/setup.get')).default
}

async function loadReposHandler() {
  return (await import('../../server/api/github/repos.get')).default
}

async function loadScanHandler() {
  return (await import('../../server/api/github/scan.get')).default
}

function createWorkspacesAdminClient(existingWorkspace: { id: string } | null = null) {
  return {
    from: vi.fn((table: string) => {
      if (table !== 'workspaces') {
        throw new Error(`Unexpected table: ${table}`)
      }

      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            neq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: existingWorkspace }),
            })),
          })),
        })),
        update: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ error: null }),
        })),
      }
    }),
  }
}

describe('GitHub route integration', () => {
  it('rejects invalid GitHub setup callbacks before any DB write', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('getPrimaryWorkspace', vi.fn())
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue(createWorkspacesAdminClient()))

    await withTestServer({
      routes: [
        { path: '/api/github/setup', handler: await loadSetupHandler() },
      ],
    }, async ({ request }) => {
      const missing = await request('/api/github/setup')
      const invalid = await request('/api/github/setup?installation_id=abc')

      expect(missing.status).toBe(400)
      expect(invalid.status).toBe(400)
    })
  })

  it('returns 409 when the GitHub installation is already linked elsewhere', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('getPrimaryWorkspace', vi.fn().mockResolvedValue({
      id: 'workspace-primary',
      slug: 'primary',
    }))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue(createWorkspacesAdminClient({
      id: 'workspace-other',
    })))

    await withTestServer({
      routes: [
        { path: '/api/github/setup', handler: await loadSetupHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/github/setup?installation_id=123')

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        status: 409,
        message: 'This GitHub installation is already linked to another workspace',
      })
    })
  })

  it('redirects successful GitHub setup callbacks to the resolved workspace', async () => {
    const updateEq = vi.fn().mockResolvedValue({ error: null })
    const adminClient = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            neq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: null }),
            })),
          })),
        })),
        update: vi.fn(() => ({
          eq: updateEq,
        })),
      })),
    }

    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('getPrimaryWorkspace', vi.fn().mockResolvedValue({
      id: 'workspace-primary',
      slug: 'studio-team',
    }))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue(adminClient))

    await withTestServer({
      routes: [
        { path: '/api/github/setup', handler: await loadSetupHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/github/setup?installation_id=123', {
        redirect: 'manual',
      })

      expect(response.status).toBe(404)
      expect(updateEq).toHaveBeenCalledWith('id', 'workspace-primary')
    })
  })

  it('blocks repository enumeration for non-admin members', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockRejectedValue(Object.assign(new Error('Requires owner or admin role'), {
      statusCode: 403,
      message: 'Requires owner or admin role',
    })))
    vi.stubGlobal('getWorkspace', vi.fn())

    await withTestServer({
      routes: [
        { path: '/api/github/repos', handler: await loadReposHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/github/repos?workspaceId=workspace-1')

      expect(response.status).toBe(403)
    })
  })

  it('scans repositories through the provider boundary and returns detected metadata', async () => {
    const detectFramework = vi.fn().mockResolvedValue({
      hasContentrain: true,
      framework: 'nuxt',
    })
    const getDefaultBranch = vi.fn().mockResolvedValue('main')
    const useGitProvider = vi.fn().mockReturnValue({
      detectFramework,
      getDefaultBranch,
    })

    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('owner'))
    vi.stubGlobal('getWorkspace', vi.fn().mockResolvedValue({
      github_installation_id: 987,
    }))
    vi.stubGlobal('useGitProvider', useGitProvider)

    await withTestServer({
      routes: [
        { path: '/api/github/scan', handler: await loadScanHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/github/scan?workspaceId=workspace-1&owner=contentrain&repo=studio')

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        defaultBranch: 'main',
        hasContentrain: true,
        framework: 'nuxt',
      })
      expect(useGitProvider).toHaveBeenCalledWith({
        installationId: 987,
        owner: 'contentrain',
        repo: 'studio',
      })
      expect(detectFramework).toHaveBeenCalledOnce()
      expect(getDefaultBranch).toHaveBeenCalledOnce()
    })
  })
})
