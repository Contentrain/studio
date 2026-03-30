import { beforeEach, describe, expect, it, vi } from 'vitest'

const octokitState = vi.hoisted(() => {
  const octokit = {
    apps: {
      getInstallation: vi.fn(),
      listReposAccessibleToInstallation: vi.fn(),
    },
    repos: {
      createUsingTemplate: vi.fn(),
      get: vi.fn(),
    },
  }

  return {
    octokit,
    Octokit: vi.fn(function Octokit() {
      return octokit
    }),
    createAppAuth: vi.fn(),
  }
})

vi.mock('@octokit/rest', () => ({
  Octokit: octokitState.Octokit,
}))

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: octokitState.createAppAuth,
}))

const providerState = vi.hoisted(() => ({
  databaseProvider: {
    getWorkspaceForUser: vi.fn(),
  },
  gitAppProvider: {
    getInstallationDetails: vi.fn(),
    listInstallationRepositories: vi.fn(),
    createRepositoryFromTemplate: vi.fn(),
    canAccessRepository: vi.fn(),
  },
}))

vi.mock('../../server/utils/providers', () => {
  return {
    useDatabaseProvider: vi.fn(() => providerState.databaseProvider),
    useGitAppProvider: vi.fn(() => providerState.gitAppProvider),
  }
})

async function loadInstallationHandler() {
  return (await import('../../server/api/github/installation.get')).default
}

async function loadCreateFromTemplateHandler() {
  return (await import('../../server/api/github/create-from-template.post')).default
}

describe('GitHub installation and template route integration', () => {
  beforeEach(() => {
    octokitState.Octokit.mockClear()
    octokitState.octokit.apps.getInstallation.mockReset()
    octokitState.octokit.apps.listReposAccessibleToInstallation.mockReset()
    octokitState.octokit.repos.createUsingTemplate.mockReset()
    octokitState.octokit.repos.get.mockReset()
    providerState.databaseProvider.getWorkspaceForUser.mockReset()
    providerState.gitAppProvider.getInstallationDetails.mockReset()
    providerState.gitAppProvider.listInstallationRepositories.mockReset()
    providerState.gitAppProvider.createRepositoryFromTemplate.mockReset()
    providerState.gitAppProvider.canAccessRepository.mockReset()
  })

  it('returns installation details and accessible repos for owner/admin users', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('getQuery', vi.fn().mockReturnValue({
      workspaceId: 'workspace-1',
    }))
    providerState.databaseProvider.getWorkspaceForUser.mockResolvedValue({
      github_installation_id: 321,
    })
    providerState.gitAppProvider.getInstallationDetails.mockResolvedValue({
      installationId: 321,
      account: {
        login: 'contentrain',
        avatarUrl: 'https://example.com/avatar.png',
        type: 'Organization',
      },
      selection: 'selected',
      permissions: { contents: 'write' },
      suspendedAt: null,
    })
    providerState.gitAppProvider.listInstallationRepositories.mockResolvedValue([
      {
        id: 1,
        name: 'studio',
        fullName: 'contentrain/studio',
        owner: 'contentrain',
        private: true,
        language: 'TypeScript',
      },
    ])

    const handler = await loadInstallationHandler()

    await expect(handler({} as never)).resolves.toEqual({
      installed: true,
      installationId: 321,
      account: {
        login: 'contentrain',
        avatarUrl: 'https://example.com/avatar.png',
        type: 'Organization',
      },
      selection: 'selected',
      permissions: { contents: 'write' },
      suspendedAt: null,
      repos: [
        {
          id: 1,
          name: 'studio',
          fullName: 'contentrain/studio',
          private: true,
          language: 'TypeScript',
        },
      ],
      settingsUrl: 'https://github.com/settings/installations/321',
    })
  })

  it('surfaces inaccessible installations without crashing', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('getQuery', vi.fn().mockReturnValue({
      workspaceId: 'workspace-1',
    }))
    providerState.databaseProvider.getWorkspaceForUser.mockResolvedValue({
      github_installation_id: 654,
    })
    providerState.gitAppProvider.getInstallationDetails.mockRejectedValue({ status: 404 })

    const handler = await loadInstallationHandler()

    await expect(handler({} as never)).resolves.toEqual({
      installed: true,
      installationId: 654,
      error: 'installation_not_accessible',
      settingsUrl: 'https://github.com/settings/installations/654',
    })
  })

  it('creates repositories from templates through the GitHub App installation', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1', email: 'owner@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      templateRepo: 'contentrain-starter-astro-blog',
      name: 'studio-template-copy',
      isPrivate: true,
      description: 'Starter repo',
    }))
    providerState.databaseProvider.getWorkspaceForUser.mockResolvedValue({
      github_installation_id: 987,
    })
    providerState.gitAppProvider.createRepositoryFromTemplate.mockResolvedValue({
      id: 44,
      fullName: 'contentrain/studio-template-copy',
      name: 'studio-template-copy',
      owner: 'contentrain',
      private: true,
      defaultBranch: 'main',
      description: 'Starter repo',
      htmlUrl: 'https://github.com/contentrain/studio-template-copy',
    })
    providerState.gitAppProvider.canAccessRepository.mockResolvedValue(true)

    const handler = await loadCreateFromTemplateHandler()

    await expect(handler({} as never)).resolves.toEqual({
      id: 44,
      fullName: 'contentrain/studio-template-copy',
      name: 'studio-template-copy',
      owner: 'contentrain',
      private: true,
      defaultBranch: 'main',
      description: 'Starter repo',
      htmlUrl: 'https://github.com/contentrain/studio-template-copy',
      needsAccess: false,
    })
  })

  it('maps GitHub template creation conflicts to 422 responses', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      templateRepo: 'contentrain-starter-astro-blog',
      name: 'studio-template-copy',
    }))
    providerState.databaseProvider.getWorkspaceForUser.mockResolvedValue({
      github_installation_id: 987,
    })
    providerState.gitAppProvider.createRepositoryFromTemplate.mockRejectedValue({
      status: 422,
      response: {
        data: {
          message: 'name already exists on this account',
        },
      },
    })

    const handler = await loadCreateFromTemplateHandler()

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 422,
    })

    consoleError.mockRestore()
  })
})
