import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { resolvePushDiff } from '../../server/utils/cdn-push-diff'
import { withTestServer } from '../helpers/http'

async function loadWebhookHandler() {
  return (await import('../../server/api/webhooks/github.post')).default
}

function signGithubBody(secret: string, payload: unknown) {
  const raw = JSON.stringify(payload)
  return {
    raw,
    signature: `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
  }
}

describe('GitHub webhook integration', () => {
  it('rejects webhook requests with an invalid signature', async () => {
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))

    await withTestServer({
      routes: [
        { path: '/api/webhooks/github', handler: await loadWebhookHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-hub-signature-256': 'sha256=invalid',
        },
        body: JSON.stringify({ ref: 'refs/heads/main' }),
      })

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 401,
      })
    })
  })

  it('flips workspaces to suspended status when GitHub sends an installation.suspend event', async () => {
    const updateWorkspaceInstallationStatus = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      updateWorkspaceInstallationStatus,
    }))

    const { raw, signature } = signGithubBody('webhook-secret', {
      action: 'suspend',
      installation: { id: 88 },
    })

    await withTestServer({
      routes: [{ path: '/api/webhooks/github', handler: await loadWebhookHandler() }],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation',
          'x-hub-signature-256': signature,
        },
        body: raw,
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        ok: true,
        event: 'installation',
        action: 'suspend',
      })
      expect(updateWorkspaceInstallationStatus).toHaveBeenCalledWith({ installationId: 88 }, 'suspended')
    })
  })

  it('flips workspaces back to active when GitHub sends installation.unsuspend', async () => {
    const updateWorkspaceInstallationStatus = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      updateWorkspaceInstallationStatus,
    }))

    const { raw, signature } = signGithubBody('webhook-secret', {
      action: 'unsuspend',
      installation: { id: 88 },
    })

    await withTestServer({
      routes: [{ path: '/api/webhooks/github', handler: await loadWebhookHandler() }],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation',
          'x-hub-signature-256': signature,
        },
        body: raw,
      })
      expect(response.status).toBe(200)
      expect(updateWorkspaceInstallationStatus).toHaveBeenCalledWith({ installationId: 88 }, 'active')
    })
  })

  it('flips matching projects to inaccessible on installation_repositories.removed', async () => {
    const updateProjectAccessStatus = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      updateProjectAccessStatus,
    }))

    const { raw, signature } = signGithubBody('webhook-secret', {
      action: 'removed',
      installation: { id: 42 },
      repositories_removed: [
        { full_name: 'alice/repo-one' },
        { full_name: 'alice/repo-two' },
      ],
    })

    await withTestServer({
      routes: [{ path: '/api/webhooks/github', handler: await loadWebhookHandler() }],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation_repositories',
          'x-hub-signature-256': signature,
        },
        body: raw,
      })
      expect(response.status).toBe(200)
      expect(updateProjectAccessStatus).toHaveBeenCalledTimes(2)
      expect(updateProjectAccessStatus).toHaveBeenCalledWith({ installationId: 42, repoFullName: 'alice/repo-one' }, 'inaccessible')
      expect(updateProjectAccessStatus).toHaveBeenCalledWith({ installationId: 42, repoFullName: 'alice/repo-two' }, 'inaccessible')
    })
  })

  it('restores matching projects to accessible on installation_repositories.added', async () => {
    const updateProjectAccessStatus = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      updateProjectAccessStatus,
    }))

    const { raw, signature } = signGithubBody('webhook-secret', {
      action: 'added',
      installation: { id: 42 },
      repositories_added: [{ full_name: 'alice/repo-one' }],
    })

    await withTestServer({
      routes: [{ path: '/api/webhooks/github', handler: await loadWebhookHandler() }],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation_repositories',
          'x-hub-signature-256': signature,
        },
        body: raw,
      })
      expect(response.status).toBe(200)
      expect(updateProjectAccessStatus).toHaveBeenCalledWith({ installationId: 42, repoFullName: 'alice/repo-one' }, 'accessible')
    })
  })

  it('flips matching project to deleted on repository.deleted', async () => {
    const updateProjectAccessStatus = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      updateProjectAccessStatus,
    }))

    const { raw, signature } = signGithubBody('webhook-secret', {
      action: 'deleted',
      installation: { id: 42 },
      repository: { full_name: 'alice/repo-one' },
    })

    await withTestServer({
      routes: [{ path: '/api/webhooks/github', handler: await loadWebhookHandler() }],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'repository',
          'x-hub-signature-256': signature,
        },
        body: raw,
      })
      expect(response.status).toBe(200)
      expect(updateProjectAccessStatus).toHaveBeenCalledWith({ installationId: 42, repoFullName: 'alice/repo-one' }, 'deleted')
    })
  })

  it('renames matching project on repository.renamed', async () => {
    const renameProjectRepo = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      renameProjectRepo,
    }))

    const { raw, signature } = signGithubBody('webhook-secret', {
      action: 'renamed',
      installation: { id: 42 },
      changes: { repository: { name: { from: 'repo-old' } } },
      repository: { full_name: 'alice/repo-new', owner: { login: 'alice' } },
    })

    await withTestServer({
      routes: [{ path: '/api/webhooks/github', handler: await loadWebhookHandler() }],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'repository',
          'x-hub-signature-256': signature,
        },
        body: raw,
      })
      expect(response.status).toBe(200)
      expect(renameProjectRepo).toHaveBeenCalledWith({ installationId: 42, oldFullName: 'alice/repo-old' }, 'alice/repo-new')
    })
  })

  it('clears linked workspaces when GitHub sends an installation.deleted event', async () => {
    const clearWorkspaceGithubInstallation = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      clearWorkspaceGithubInstallation,
    }))

    const { raw, signature } = signGithubBody('webhook-secret', {
      action: 'deleted',
      installation: { id: 77 },
    })

    await withTestServer({
      routes: [
        { path: '/api/webhooks/github', handler: await loadWebhookHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation',
          'x-hub-signature-256': signature,
        },
        body: raw,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        ok: true,
        event: 'installation',
        action: 'deleted',
      })
      expect(clearWorkspaceGithubInstallation).toHaveBeenCalledWith(77)
    })
  })

  it('ignores CDN builds when a push hits a different branch than the configured CDN branch', async () => {
    const executeCDNBuild = vi.fn()
    const createCDNBuild = vi.fn()

    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({}))
    vi.stubGlobal('executeCDNBuild', executeCDNBuild)
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('normalizeContentRoot', vi.fn().mockImplementation((value: string | null) => value ?? ''))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      updateProjectContentTimestamp: vi.fn().mockResolvedValue(undefined),
      listCDNEnabledProjects: vi.fn().mockResolvedValue([{
        id: 'project-1',
        workspace_id: 'workspace-1',
        content_root: '.',
        cdn_enabled: true,
        cdn_branch: 'preview',
        default_branch: 'main',
      }]),
      getWorkspaceById: vi.fn().mockResolvedValue({ plan: 'pro' }),
      createCDNBuild,
      updateCDNBuild: vi.fn().mockResolvedValue(undefined),
    }))

    const payload = {
      ref: 'refs/heads/main',
      after: 'commit-sha-1',
      repository: { full_name: 'acme/site' },
      commits: [{ modified: ['content/posts/en.json'] }],
    }
    const { raw, signature } = signGithubBody('webhook-secret', payload)

    await withTestServer({
      routes: [
        { path: '/api/webhooks/github', handler: await loadWebhookHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-hub-signature-256': signature,
        },
        body: raw,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        ok: true,
        event: 'push',
        repo: 'acme/site',
      })
      expect(createCDNBuild).not.toHaveBeenCalled()
      expect(executeCDNBuild).not.toHaveBeenCalled()
    })
  })

  // ─── Issue #133: compare-derived CDN build paths ───

  function stubCdnPushGlobals(input: {
    getBranchDiff: ReturnType<typeof vi.fn>
    executeCDNBuild?: ReturnType<typeof vi.fn>
    createCDNBuild?: ReturnType<typeof vi.fn>
    installationId?: number | null
  }) {
    const executeCDNBuild = input.executeCDNBuild ?? vi.fn().mockResolvedValue({})
    const createCDNBuild = input.createCDNBuild ?? vi.fn().mockResolvedValue({ id: 'build-1' })

    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({}))
    vi.stubGlobal('executeCDNBuild', executeCDNBuild)
    vi.stubGlobal('resolvePushDiff', resolvePushDiff)
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('normalizeContentRoot', vi.fn().mockImplementation((value: string | null) => value ?? ''))
    vi.stubGlobal('useGitProvider', vi.fn().mockReturnValue({ getBranchDiff: input.getBranchDiff }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      updateProjectContentTimestamp: vi.fn().mockResolvedValue(undefined),
      listCDNEnabledProjects: vi.fn().mockResolvedValue([{
        id: 'project-1',
        workspace_id: 'workspace-1',
        content_root: '.',
        cdn_enabled: true,
        cdn_branch: 'main',
        default_branch: 'main',
      }]),
      getWorkspaceById: vi.fn().mockResolvedValue({
        plan: 'pro',
        github_installation_id: input.installationId === undefined ? 42 : input.installationId,
      }),
      createCDNBuild,
      updateCDNBuild: vi.fn().mockResolvedValue(undefined),
    }))

    return { executeCDNBuild, createCDNBuild }
  }

  async function postPush(payload: unknown) {
    const { raw, signature } = signGithubBody('webhook-secret', payload)
    let status = 0
    await withTestServer({
      routes: [
        { path: '/api/webhooks/github', handler: await loadWebhookHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-hub-signature-256': signature,
        },
        body: raw,
      })
      status = response.status
    })
    return status
  }

  it('derives CDN build paths from the compare API, not payload commit file lists', async () => {
    // Merge-push shape: the payload commit carries NO file lists — only
    // the compare knows what actually changed (issue #133).
    const getBranchDiff = vi.fn().mockResolvedValue([
      { path: '.contentrain/content/blog/posts/en.json', status: 'modified', before: null, after: null },
    ])
    const { executeCDNBuild, createCDNBuild } = stubCdnPushGlobals({ getBranchDiff })

    const status = await postPush({
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      repository: { full_name: 'acme/site' },
      commits: [{ added: [], modified: [], removed: [] }],
    })

    expect(status).toBe(200)
    expect(getBranchDiff).toHaveBeenCalledWith('b'.repeat(40), 'a'.repeat(40))
    expect(createCDNBuild).toHaveBeenCalled()
    expect(executeCDNBuild).toHaveBeenCalledWith(expect.objectContaining({
      changedPaths: ['.contentrain/content/blog/posts/en.json'],
      fullRebuild: undefined,
    }))
  })

  it('skips the build entirely when the compare shows an identical tree', async () => {
    const { executeCDNBuild, createCDNBuild } = stubCdnPushGlobals({
      getBranchDiff: vi.fn().mockResolvedValue([]),
    })

    const status = await postPush({
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      repository: { full_name: 'acme/site' },
      commits: [],
    })

    expect(status).toBe(200)
    expect(createCDNBuild).not.toHaveBeenCalled()
    expect(executeCDNBuild).not.toHaveBeenCalled()
  })

  it('never creates a build record when the installation is missing (no stuck pending rows)', async () => {
    const { executeCDNBuild, createCDNBuild } = stubCdnPushGlobals({
      getBranchDiff: vi.fn(),
      installationId: null,
    })

    const status = await postPush({
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      repository: { full_name: 'acme/site' },
      commits: [],
    })

    expect(status).toBe(200)
    expect(createCDNBuild).not.toHaveBeenCalled()
    expect(executeCDNBuild).not.toHaveBeenCalled()
  })
})
