import { beforeEach, describe, expect, it, vi } from 'vitest'

const providerState = vi.hoisted(() => ({
  databaseProvider: {
    getAdminClient: vi.fn(),
  },
}))

const eventStreamState = vi.hoisted(() => ({
  createEventStream: vi.fn(),
  stream: {
    push: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    onClosed: vi.fn(),
    send: vi.fn().mockResolvedValue('stream-sent'),
  },
}))

vi.mock('h3', async () => {
  const actual = await vi.importActual<typeof import('h3')>('h3')

  return {
    ...actual,
    createEventStream: eventStreamState.createEventStream,
  }
})

vi.mock('../../server/utils/providers', () => {
  return {
    useDatabaseProvider: vi.fn(() => providerState.databaseProvider),
  }
})

async function loadPublicCDNHandler() {
  return (await import('../../server/api/cdn/v1/[projectId]/[...path].get')).default
}

async function loadCDNSettingsPatchHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/cdn/settings.patch')).default
}

async function loadCDNSettingsGetHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/cdn/settings.get')).default
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
  beforeEach(() => {
    providerState.databaseProvider.getAdminClient.mockReset()
    eventStreamState.createEventStream.mockReset()
    eventStreamState.stream.push.mockClear()
    eventStreamState.stream.close.mockClear()
    eventStreamState.stream.onClosed.mockClear()
    eventStreamState.stream.send.mockClear()
  })

  it('returns 304 when the requested CDN object matches the provided ETag', async () => {
    const event = {} as never
    const setResponseHeader = vi.fn()
    const setResponseStatus = vi.fn()

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'projectId') return 'project-1'
      if (key === 'path') return 'models/posts'
      return undefined
    }))
    vi.stubGlobal('getHeader', vi.fn((_: unknown, key: string) => {
      if (key === 'authorization') return 'Bearer crn_live_example'
      if (key === 'if-none-match') return 'etag-1'
      return undefined
    }))
    vi.stubGlobal('setResponseHeader', setResponseHeader)
    vi.stubGlobal('setResponseStatus', setResponseStatus)
    vi.stubGlobal('validateCDNKey', vi.fn().mockResolvedValue({
      projectId: 'project-1',
      keyId: 'key-1',
      rateLimitPerHour: 60,
      allowedOrigins: [],
    }))
    vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({
      allowed: true,
      remaining: 59,
      retryAfterMs: 0,
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
    providerState.databaseProvider.getAdminClient.mockReturnValue({
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
    })

    const handler = await loadPublicCDNHandler()

    await expect(handler(event)).resolves.toBe('')
    expect(setResponseStatus).toHaveBeenCalledWith(event, 304)
    expect(setResponseHeader).toHaveBeenCalledWith(event, 'X-RateLimit-Remaining', '59')
  })

  it('blocks CDN reads from disallowed origins', async () => {
    const event = {} as never
    vi.stubGlobal('getHeader', vi.fn((_: unknown, key: string) => {
      if (key === 'authorization') return 'Bearer crn_live_example'
      if (key === 'origin') return 'https://evil.example'
      return undefined
    }))
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

    const handler = await loadPublicCDNHandler()

    await expect(handler(event)).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('returns binary CDN payloads as raw buffers without UTF-8 conversion', async () => {
    const event = {} as never
    const binary = Buffer.from([0, 255, 16, 32, 128, 64])
    const setResponseHeader = vi.fn()

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'projectId') return 'project-1'
      if (key === 'path') return 'media/logo.png'
      return undefined
    }))
    vi.stubGlobal('getHeader', vi.fn((_: unknown, key: string) => {
      if (key === 'authorization') return 'Bearer crn_live_example'
      return undefined
    }))
    vi.stubGlobal('setResponseHeader', setResponseHeader)
    vi.stubGlobal('validateCDNKey', vi.fn().mockResolvedValue({
      projectId: 'project-1',
      keyId: 'key-1',
      rateLimitPerHour: 60,
      allowedOrigins: [],
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockImplementation((_: string, feature: string) => feature !== 'cdn.metering'))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({
      getObject: vi.fn().mockResolvedValue({
        etag: 'etag-binary',
        contentType: 'image/png',
        data: binary,
      }),
    }))
    providerState.databaseProvider.getAdminClient.mockReturnValue({
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
    })

    const handler = await loadPublicCDNHandler()

    await expect(handler(event)).resolves.toEqual(binary)
    expect(setResponseHeader).toHaveBeenCalledWith(event, 'Content-Type', 'image/png')
    expect(setResponseHeader).toHaveBeenCalledWith(event, 'ETag', 'etag-binary')
  })

  it('rejects enabling CDN on plans without the delivery feature', async () => {
    const event = {} as never
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ cdn_enabled: true }))
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

    const handler = await loadCDNSettingsPatchHandler()

    await expect(handler(event)).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('loads CDN settings only when the project belongs to the workspace path', async () => {
    const event = {} as never
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table !== 'projects') {
          throw new Error(`Unexpected table: ${table}`)
        }

        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { cdn_enabled: true, cdn_branch: 'release' },
                  error: null,
                }),
              })),
            })),
          })),
        }
      }),
    }))

    const handler = await loadCDNSettingsGetHandler()

    await expect(handler(event)).resolves.toEqual({
      cdn_enabled: true,
      cdn_branch: 'release',
    })
  })

  it('returns 404 when creating a CDN key through the wrong workspace path', async () => {
    const event = {} as never
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-foreign'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ name: 'Public site key' }))
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

    const handler = await loadCDNKeyCreateHandler()

    await expect(handler(event)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('streams a successful manual CDN rebuild', async () => {
    const event = {} as never
    const updateBuildRecord = vi.fn().mockResolvedValue({ error: null })
    eventStreamState.createEventStream.mockReturnValue(eventStreamState.stream)

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

    const handler = await loadCDNBuildTriggerHandler()
    await expect(handler(event)).resolves.toBe('stream-sent')
    await Promise.resolve()
    await Promise.resolve()

    expect(updateBuildRecord).toHaveBeenCalledWith('id', 'build-1')
    expect(eventStreamState.stream.push).toHaveBeenCalledWith(expect.stringContaining('"phase":"upload"'))
    expect(eventStreamState.stream.push).toHaveBeenCalledWith(expect.stringContaining('"phase":"complete"'))
    expect(eventStreamState.stream.close).toHaveBeenCalledOnce()
    expect(eventStreamState.stream.onClosed).toHaveBeenCalledOnce()
  })

  it('returns 404 for CDN build history requested through the wrong workspace path', async () => {
    const event = {} as never
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

    const handler = await loadCDNBuildsHandler()

    await expect(handler(event)).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})
