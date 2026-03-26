import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

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
  })

  it('returns installation details and accessible repos for owner/admin users', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('owner'))
    vi.stubGlobal('getWorkspace', vi.fn().mockResolvedValue({
      github_installation_id: 321,
    }))

    octokitState.octokit.apps.getInstallation.mockResolvedValue({
      data: {
        account: {
          login: 'contentrain',
          avatar_url: 'https://example.com/avatar.png',
        },
        target_type: 'Organization',
        repository_selection: 'selected',
        permissions: { contents: 'write' },
        suspended_at: null,
      },
    })
    octokitState.octokit.apps.listReposAccessibleToInstallation.mockResolvedValue({
      data: {
        repositories: [
          {
            id: 1,
            name: 'studio',
            full_name: 'contentrain/studio',
            private: true,
            language: 'TypeScript',
          },
        ],
      },
    })

    await withTestServer({
      routes: [
        { path: '/api/github/installation', handler: await loadInstallationHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/github/installation?workspaceId=workspace-1')

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
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
  })

  it('surfaces inaccessible installations without crashing', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('admin'))
    vi.stubGlobal('getWorkspace', vi.fn().mockResolvedValue({
      github_installation_id: 654,
    }))

    octokitState.octokit.apps.getInstallation.mockRejectedValue({ status: 404 })

    await withTestServer({
      routes: [
        { path: '/api/github/installation', handler: await loadInstallationHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/github/installation?workspaceId=workspace-1')

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        installed: true,
        installationId: 654,
        error: 'installation_not_accessible',
        settingsUrl: 'https://github.com/settings/installations/654',
      })
    })
  })

  it('creates repositories from templates through the GitHub App installation', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1', email: 'owner@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('owner'))
    vi.stubGlobal('getWorkspace', vi.fn().mockResolvedValue({
      github_installation_id: 987,
    }))

    octokitState.octokit.apps.getInstallation.mockResolvedValue({
      data: {
        account: { login: 'contentrain' },
      },
    })
    octokitState.octokit.repos.createUsingTemplate.mockResolvedValue({
      data: {
        id: 44,
        full_name: 'contentrain/studio-template-copy',
        name: 'studio-template-copy',
        owner: { login: 'contentrain' },
        private: true,
        default_branch: 'main',
        description: 'Starter repo',
        html_url: 'https://github.com/contentrain/studio-template-copy',
      },
    })
    octokitState.octokit.repos.get.mockResolvedValue({
      data: { id: 44 },
    })

    await withTestServer({
      routes: [
        { path: '/api/github/create-from-template', handler: await loadCreateFromTemplateHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/github/create-from-template', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'workspace-1',
          templateRepo: 'contentrain-starter-astro-blog',
          name: 'studio-template-copy',
          isPrivate: true,
          description: 'Starter repo',
        }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
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
  })

  it('maps GitHub template creation conflicts to 422 responses', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('owner'))
    vi.stubGlobal('getWorkspace', vi.fn().mockResolvedValue({
      github_installation_id: 987,
    }))

    octokitState.octokit.apps.getInstallation.mockResolvedValue({
      data: {
        account: { login: 'contentrain' },
      },
    })
    octokitState.octokit.repos.createUsingTemplate.mockRejectedValue({
      status: 422,
      response: {
        data: {
          message: 'name already exists on this account',
        },
      },
    })

    await withTestServer({
      routes: [
        { path: '/api/github/create-from-template', handler: await loadCreateFromTemplateHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/github/create-from-template', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'workspace-1',
          templateRepo: 'contentrain-starter-astro-blog',
          name: 'studio-template-copy',
        }),
      })

      expect(response.status).toBe(422)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 422,
      })
    })

    consoleError.mockRestore()
  })
})
