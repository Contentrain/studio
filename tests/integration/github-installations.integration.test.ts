import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadAvailableHandler() {
  return (await import('../../server/api/github/installations/available.get')).default
}

async function loadConnectHandler() {
  return (await import('../../server/api/github/installations/connect.post')).default
}

function stubGetQuery(query: Record<string, unknown>) {
  vi.stubGlobal('getQuery', vi.fn().mockReturnValue(query))
}

function stubReadBody(body: Record<string, unknown>) {
  vi.stubGlobal('readBody', vi.fn().mockResolvedValue(body))
}

describe('github installations integration', () => {
  describe('GET /api/github/installations/available', () => {
    it('returns 401 with reauth code when no provider token is stored', async () => {
      stubGetQuery({ workspaceId: 'ws-1' })
      vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
        user: { id: 'user-1' },
        accessToken: 'token-1',
      }))
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1' }),
        getOAuthProviderToken: vi.fn().mockResolvedValue(null),
      }))

      await withTestServer({
        routes: [{ path: '/api/github/installations/available', handler: await loadAvailableHandler() }],
      }, async ({ request }) => {
        const response = await request('/api/github/installations/available?workspaceId=ws-1')
        expect(response.status).toBe(401)
        const body = await response.json()
        expect(body.data?.code).toBe('GITHUB_REAUTH_REQUIRED')
      })
    })

    it('returns installations annotated with boundWorkspace', async () => {
      stubGetQuery({ workspaceId: 'ws-1' })
      vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
        user: { id: 'user-1' },
        accessToken: 'token-1',
      }))
      const findWorkspaceByGithubInstallation = vi.fn()
        .mockImplementation(async (id: number) => id === 222 ? { id: 'other-ws', name: 'Other', slug: 'other' } : null)
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1' }),
        getOAuthProviderToken: vi.fn().mockResolvedValue({
          accessToken: 'gho_test',
          refreshToken: null,
          expiresAt: null,
          refreshTokenExpiresAt: null,
        }),
        findWorkspaceByGithubInstallation,
      }))
      const listInstallationsForUser = vi.fn().mockResolvedValue([
        { id: 111, account: { login: 'alice', avatarUrl: null, type: 'User' }, repositorySelection: 'all', targetType: 'User' },
        { id: 222, account: { login: 'acme', avatarUrl: null, type: 'Organization' }, repositorySelection: 'selected', targetType: 'Organization' },
      ])
      vi.stubGlobal('useGitAppService', vi.fn().mockReturnValue({ listInstallationsForUser }))

      await withTestServer({
        routes: [{ path: '/api/github/installations/available', handler: await loadAvailableHandler() }],
      }, async ({ request }) => {
        const response = await request('/api/github/installations/available?workspaceId=ws-1')
        expect(response.status).toBe(200)
        const body = await response.json() as { installations: Array<{ id: number, boundWorkspace: unknown }> }
        expect(body.installations).toHaveLength(2)
        expect(body.installations[0]).toMatchObject({ id: 111, boundWorkspace: null })
        expect(body.installations[1]).toMatchObject({ id: 222, boundWorkspace: { id: 'other-ws', name: 'Other', slug: 'other' } })
      })
    })
  })

  describe('POST /api/github/installations/connect', () => {
    it('rejects 403 when user has no GitHub access to the installation', async () => {
      stubReadBody({ workspaceId: 'ws-1', installationId: 999 })
      vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
        user: { id: 'user-1' },
        accessToken: 'token-1',
      }))
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1' }),
        getOAuthProviderToken: vi.fn().mockResolvedValue({
          accessToken: 'gho_test', refreshToken: null, expiresAt: null, refreshTokenExpiresAt: null,
        }),
      }))
      vi.stubGlobal('useGitAppService', vi.fn().mockReturnValue({
        verifyUserHasAccessToInstallation: vi.fn().mockResolvedValue(false),
      }))

      await withTestServer({
        routes: [{ path: '/api/github/installations/connect', handler: await loadConnectHandler() }],
      }, async ({ request }) => {
        const response = await request('/api/github/installations/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: 'ws-1', installationId: 999 }),
        })
        expect(response.status).toBe(403)
      })
    })

    it('rejects 409 when installation is already bound to another workspace', async () => {
      stubReadBody({ workspaceId: 'ws-1', installationId: 222 })
      vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
        user: { id: 'user-1' },
        accessToken: 'token-1',
      }))
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1' }),
        getOAuthProviderToken: vi.fn().mockResolvedValue({
          accessToken: 'gho_test', refreshToken: null, expiresAt: null, refreshTokenExpiresAt: null,
        }),
        findWorkspaceByGithubInstallation: vi.fn().mockResolvedValue({ id: 'other-ws' }),
      }))
      vi.stubGlobal('useGitAppService', vi.fn().mockReturnValue({
        verifyUserHasAccessToInstallation: vi.fn().mockResolvedValue(true),
      }))

      await withTestServer({
        routes: [{ path: '/api/github/installations/connect', handler: await loadConnectHandler() }],
      }, async ({ request }) => {
        const response = await request('/api/github/installations/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: 'ws-1', installationId: 222 }),
        })
        expect(response.status).toBe(409)
      })
    })

    it('binds the installation when ownership verified and no collision', async () => {
      stubReadBody({ workspaceId: 'ws-1', installationId: 333 })
      vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
        user: { id: 'user-1' },
        accessToken: 'token-1',
      }))
      const updateWorkspaceGithubInstallation = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1' }),
        getOAuthProviderToken: vi.fn().mockResolvedValue({
          accessToken: 'gho_test', refreshToken: null, expiresAt: null, refreshTokenExpiresAt: null,
        }),
        findWorkspaceByGithubInstallation: vi.fn().mockResolvedValue(null),
        updateWorkspaceGithubInstallation,
      }))
      vi.stubGlobal('useGitAppService', vi.fn().mockReturnValue({
        verifyUserHasAccessToInstallation: vi.fn().mockResolvedValue(true),
      }))

      await withTestServer({
        routes: [{ path: '/api/github/installations/connect', handler: await loadConnectHandler() }],
      }, async ({ request }) => {
        const response = await request('/api/github/installations/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: 'ws-1', installationId: 333 }),
        })
        expect(response.status).toBe(200)
        expect(updateWorkspaceGithubInstallation).toHaveBeenCalledWith('ws-1', 333)
      })
    })
  })
})
