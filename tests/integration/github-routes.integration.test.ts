import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

const providerState = vi.hoisted(() => ({
  databaseProvider: {
    getWorkspaceForUser: vi.fn(),
    findWorkspaceByGithubInstallation: vi.fn(),
    updateWorkspaceGithubInstallation: vi.fn(),
  },
  gitAppProvider: {
    listInstallationRepositories: vi.fn(),
  },
  gitProviderFactory: vi.fn(),
}))

vi.mock('../../server/utils/providers', () => ({
  useDatabaseProvider: vi.fn(() => providerState.databaseProvider),
  useGitAppProvider: vi.fn(() => providerState.gitAppProvider),
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
    providerState.databaseProvider.getWorkspaceForUser.mockReset()
    providerState.databaseProvider.findWorkspaceByGithubInstallation.mockReset()
    providerState.databaseProvider.updateWorkspaceGithubInstallation.mockReset()
    providerState.gitAppProvider.listInstallationRepositories.mockReset()
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
