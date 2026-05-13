import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

const providerState = vi.hoisted(() => ({
  databaseProvider: {
    getWorkspaceForUser: vi.fn(),
    findWorkspaceByGithubInstallation: vi.fn(),
    updateWorkspaceGithubInstallation: vi.fn(),
    getOAuthProviderToken: vi.fn(),
  },
  authProvider: {
    refreshProviderToken: vi.fn(),
  },
  gitAppProvider: {
    listInstallationRepositories: vi.fn(),
  },
  gitAppService: {
    listInstallationsForUser: vi.fn(),
    verifyUserHasAccessToInstallation: vi.fn(),
  },
  gitProviderFactory: vi.fn(),
}))

vi.mock('../../server/utils/providers', () => ({
  useDatabaseProvider: vi.fn(() => providerState.databaseProvider),
  useAuthProvider: vi.fn(() => providerState.authProvider),
  useGitAppProvider: vi.fn(() => providerState.gitAppProvider),
  useGitAppService: vi.fn(() => providerState.gitAppService),
  useGitProvider: providerState.gitProviderFactory,
}))

async function loadSetupHandler() {
  return (await import('../../server/api/github/setup.get')).default
}

async function loadReposHandler() {
  return (await import('../../server/api/github/repos.get')).default
}

async function loadScanHandler() {
  return (await import('../../server/api/github/scan.get')).default
}

describe('GitHub route integration', () => {
  beforeEach(() => {
    // The `vi.mock` above routes named imports inside setup.get / repos /
    // scan to the providerState. But `server/utils/github-token.ts` (used
    // by setup.get for the ownership-verification branch) consumes
    // `useDatabaseProvider` and `useAuthProvider` via Nuxt auto-import,
    // not via named import — auto-import bypasses module mocks. We mirror
    // the mocks onto the global namespace so the helper sees the same
    // providerState the named imports do.
    vi.stubGlobal('useDatabaseProvider', () => providerState.databaseProvider)
    vi.stubGlobal('useAuthProvider', () => providerState.authProvider)

    providerState.databaseProvider.getWorkspaceForUser.mockReset()
    providerState.databaseProvider.findWorkspaceByGithubInstallation.mockReset()
    providerState.databaseProvider.updateWorkspaceGithubInstallation.mockReset()
    providerState.databaseProvider.getOAuthProviderToken.mockReset()
    // Default: no stored GitHub user token. setup.get.ts treats this as
    // "skip ownership verification" (Google sign-in / magic-link path);
    // tests that exercise the ownership-verify branch override per-case.
    providerState.databaseProvider.getOAuthProviderToken.mockResolvedValue(null)
    providerState.authProvider.refreshProviderToken.mockReset()
    providerState.gitAppProvider.listInstallationRepositories.mockReset()
    providerState.gitAppService.listInstallationsForUser.mockReset()
    providerState.gitAppService.verifyUserHasAccessToInstallation.mockReset()
    providerState.gitProviderFactory.mockReset()
  })

  it('rejects invalid GitHub setup callbacks before any DB write', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))

    await withTestServer({
      routes: [
        { path: '/api/github/setup', handler: await loadSetupHandler() },
      ],
    }, async ({ request }) => {
      const missing = await request('/api/github/setup')
      const invalid = await request('/api/github/setup?installation_id=abc&state=workspace-1')

      expect(missing.status).toBe(400)
      expect(invalid.status).toBe(400)
    })
  })

  it('returns 409 when the GitHub installation is already linked elsewhere', async () => {
    providerState.databaseProvider.getWorkspaceForUser.mockResolvedValue({
      id: 'workspace-primary',
      slug: 'primary',
    })
    providerState.databaseProvider.findWorkspaceByGithubInstallation.mockResolvedValue({
      id: 'workspace-other',
    })

    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))

    await withTestServer({
      routes: [
        { path: '/api/github/setup', handler: await loadSetupHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/github/setup?installation_id=123&state=workspace-primary')

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 409,
      })
      expect(providerState.databaseProvider.getWorkspaceForUser).toHaveBeenCalledWith('token-1', 'user-1', 'workspace-primary', ['owner', 'admin'])
      expect(providerState.databaseProvider.findWorkspaceByGithubInstallation).toHaveBeenCalledWith(123, 'workspace-primary')
    })
  })

  it('redirects successful GitHub setup callbacks to the resolved workspace', async () => {
    providerState.databaseProvider.getWorkspaceForUser.mockResolvedValue({
      id: 'workspace-primary',
      slug: 'studio-team',
    })
    providerState.databaseProvider.findWorkspaceByGithubInstallation.mockResolvedValue(null)
    providerState.databaseProvider.updateWorkspaceGithubInstallation.mockResolvedValue(undefined)

    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))

    await withTestServer({
      routes: [
        { path: '/api/github/setup', handler: await loadSetupHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/github/setup?installation_id=123&state=workspace-primary', {
        redirect: 'manual',
      })

      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('/w/studio-team')
      expect(providerState.databaseProvider.updateWorkspaceGithubInstallation).toHaveBeenCalledWith('workspace-primary', 123)
    })
  })

  it('blocks repository enumeration for non-admin members', async () => {
    providerState.databaseProvider.getWorkspaceForUser.mockRejectedValue(Object.assign(new Error('Requires owner or admin role'), {
      statusCode: 403,
      message: 'Requires owner or admin role',
    }))

    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))

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
    providerState.databaseProvider.getWorkspaceForUser.mockResolvedValue({
      github_installation_id: 987,
    })
    providerState.gitProviderFactory.mockReturnValue({
      detectFramework,
      getDefaultBranch,
    })

    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))

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
      expect(providerState.gitProviderFactory).toHaveBeenCalledWith({
        installationId: 987,
        owner: 'contentrain',
        repo: 'studio',
      })
      expect(detectFramework).toHaveBeenCalledOnce()
      expect(getDefaultBranch).toHaveBeenCalledOnce()
    })
  })
})
