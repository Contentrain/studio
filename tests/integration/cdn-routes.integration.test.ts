import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadPublicCDNHandler() {
  return (await import('../../server/api/cdn/v1/[projectId]/[...path].get')).default
}

async function loadCDNSettingsPatchHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/cdn/settings.patch')).default
}

async function loadCDNBuildTriggerHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/cdn/builds/trigger.post')).default
}

async function loadCDNBuildsHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/cdn/builds/index.get')).default
}

async function loadCDNKeyCreateHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/cdn/keys/index.post')).default
}

describe('CDN route integration', () => {
  it('returns 304 when the requested CDN object matches the provided ETag', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'projectId') return 'project-1'
      if (key === 'path') return 'models/posts'
      return undefined
    }))
    vi.stubGlobal('validateCDNKey', vi.fn().mockResolvedValue({
      projectId: 'project-1',
      keyId: 'key-1',
      rateLimitPerHour: 60,
      allowedOrigins: [],
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({
      getObject: vi.fn().mockResolvedValue({
        etag: 'etag-1',
        contentType: 'application/json',
        data: Buffer.from('{"ok":true}'),
      }),
    }))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'projects') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { workspace_id: 'workspace-1', cdn_enabled: true },
                }),
              })),
            })),
          }
        }

        if (table === 'workspaces') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { plan: 'pro' },
                }),
              })),
            })),
          }
        }

        throw new Error(`Unexpected table: ${table}`)
      }),
    }))

    await withTestServer({
      routes: [
        { path: '/api/cdn/v1/project-1/models/posts', handler: await loadPublicCDNHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/cdn/v1/project-1/models/posts', {
        headers: {
          'authorization': 'Bearer crn_live_example',
          'if-none-match': 'etag-1',
        },
      })

      expect(response.status).toBe(304)
      expect(await response.text()).toBe('')
    })
  })

  it('blocks CDN reads from disallowed origins', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'projectId') return 'project-1'
      if (key === 'path') return 'models/posts'
      return undefined
    }))
    vi.stubGlobal('validateCDNKey', vi.fn().mockResolvedValue({
      projectId: 'project-1',
      keyId: 'key-1',
      rateLimitPerHour: 60,
      allowedOrigins: ['https://allowed.example'],
    }))

    await withTestServer({
      routes: [
        { path: '/api/cdn/v1/project-1/models/posts', handler: await loadPublicCDNHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/cdn/v1/project-1/models/posts', {
        headers: {
          authorization: 'Bearer crn_live_example',
          origin: 'https://evil.example',
        },
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 403,
      })
    })
  })

  it('rejects enabling CDN on plans without the delivery feature', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('owner'))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('free'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table !== 'workspaces') {
          throw new Error(`Unexpected table: ${table}`)
        }

        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: { plan: 'free' } }),
            })),
          })),
        }
      }),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/cdn/settings', handler: await loadCDNSettingsPatchHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/cdn/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cdn_enabled: true }),
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 403,
      })
    })
  })

  it('returns 404 when creating a CDN key through the wrong workspace path', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-foreign'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('owner'))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table !== 'projects') {
          throw new Error(`Unexpected table: ${table}`)
        }

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
        { path: '/api/workspaces/workspace-1/projects/project-foreign/cdn/keys', handler: await loadCDNKeyCreateHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-foreign/cdn/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Public site key' }),
      })

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 404,
      })
    })
  })

  it('streams a successful manual CDN rebuild', async () => {
    const updateBuildRecord = vi.fn().mockResolvedValue({ error: null })

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('owner'))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {
        listBranches: vi.fn().mockResolvedValue([{ name: 'main', sha: 'abc123', protected: true }]),
      },
      contentRoot: '.',
    }))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({}))
    vi.stubGlobal('executeCDNBuild', vi.fn().mockImplementation(async ({ onProgress }) => {
      onProgress?.({ phase: 'upload', message: 'Uploading files', current: 1, total: 2 })
      return {
        filesUploaded: 2,
        totalSizeBytes: 2048,
        changedModels: ['posts'],
        durationMs: 321,
        error: null,
      }
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ data: { plan: 'pro' } }),
              })),
            })),
          }
        }

        if (table === 'projects') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { cdn_enabled: true, cdn_branch: null, default_branch: 'main' },
                }),
              })),
            })),
          }
        }

        throw new Error(`Unexpected table: ${table}`)
      }),
    }))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table !== 'cdn_builds') {
          throw new Error(`Unexpected table: ${table}`)
        }

        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: { id: 'build-1' }, error: null }),
            })),
          })),
          update: vi.fn(() => ({
            eq: updateBuildRecord,
          })),
        }
      }),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/cdn/builds/trigger', handler: await loadCDNBuildTriggerHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/cdn/builds/trigger', {
        method: 'POST',
      })
      const payload = await response.text()

      expect(response.status).toBe(200)
      expect(payload).toContain('"phase":"upload"')
      expect(payload).toContain('"phase":"complete"')
      expect(payload).toContain('Build complete')
      expect(updateBuildRecord).toHaveBeenCalledWith('id', 'build-1')
    })
  })

  it('returns 404 for CDN build history requested through the wrong workspace path', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-foreign'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'projects') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn().mockResolvedValue({ data: null }),
                })),
              })),
            })),
          }
        }

        if (table === 'cdn_builds') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue({ data: [] }),
                })),
              })),
            })),
          }
        }

        throw new Error(`Unexpected table: ${table}`)
      }),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-foreign/cdn/builds', handler: await loadCDNBuildsHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-foreign/cdn/builds')

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 404,
      })
    })
  })
})
