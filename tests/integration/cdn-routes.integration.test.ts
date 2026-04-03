import { beforeEach, describe, expect, it, vi } from 'vitest'

const providerState = vi.hoisted(() => ({
  databaseProvider: {
    requireWorkspaceRole: vi.fn(),
    getWorkspaceById: vi.fn(),
    getProjectForWorkspace: vi.fn(),
    getProjectById: vi.fn(),
    createCDNBuild: vi.fn(),
    updateCDNBuild: vi.fn(),
    createCDNKey: vi.fn(),
    countActiveCDNKeys: vi.fn(),
    listCDNKeys: vi.fn(),
    listCDNBuilds: vi.fn(),
    revokeCDNKey: vi.fn(),
    updateProject: vi.fn(),
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
    providerState.databaseProvider.requireWorkspaceRole.mockReset()
    providerState.databaseProvider.getWorkspaceById.mockReset()
    providerState.databaseProvider.getProjectForWorkspace.mockReset()
    providerState.databaseProvider.getProjectById.mockReset()
    providerState.databaseProvider.createCDNBuild.mockReset()
    providerState.databaseProvider.updateCDNBuild.mockReset()
    providerState.databaseProvider.createCDNKey.mockReset()
    providerState.databaseProvider.countActiveCDNKeys.mockReset()
    providerState.databaseProvider.listCDNKeys.mockReset()
    providerState.databaseProvider.listCDNBuilds.mockReset()
    providerState.databaseProvider.revokeCDNKey.mockReset()
    providerState.databaseProvider.updateProject.mockReset()
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
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getProjectById: vi.fn().mockResolvedValue({ workspace_id: 'workspace-1', cdn_enabled: true }),
      getWorkspaceById: vi.fn().mockResolvedValue({ plan: 'pro' }),
    }))

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
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getProjectById: vi.fn().mockResolvedValue({ workspace_id: 'workspace-1', cdn_enabled: true }),
      getWorkspaceById: vi.fn().mockResolvedValue({ plan: 'pro' }),
    }))

    const handler = await loadPublicCDNHandler()

    await expect(handler(event)).resolves.toEqual(binary)
    expect(setResponseHeader).toHaveBeenCalledWith(event, 'Content-Type', 'image/png')
    expect(setResponseHeader).toHaveBeenCalledWith(event, 'ETag', 'etag-binary')
  })

  it('rejects enabling CDN on plans without the delivery feature', async () => {
    const event = { context: {} } as never
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
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('starter'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
    vi.stubGlobal('getUpgradeParams', vi.fn().mockReturnValue({ requiredPlan: 'pro' }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
      getWorkspaceById: vi.fn().mockResolvedValue({ plan: 'starter' }),
      updateProject: vi.fn(),
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

    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getProjectForWorkspace: vi.fn().mockResolvedValue({ cdn_enabled: true, cdn_branch: 'release' }),
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
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
      getProjectForWorkspace: vi.fn().mockResolvedValue(null),
    }))

    const handler = await loadCDNKeyCreateHandler()

    await expect(handler(event)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('streams a successful manual CDN rebuild', async () => {
    const event = { context: {} } as never
    const updateCDNBuild = vi.fn().mockResolvedValue(undefined)
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
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {
        listBranches: vi.fn().mockResolvedValue([{ name: 'main', sha: 'abc123', protected: true }]),
      },
      contentRoot: '.',
    }))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({}))
    vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
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
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
      getWorkspaceById: vi.fn().mockResolvedValue({ plan: 'pro' }),
      getProjectForWorkspace: vi.fn().mockResolvedValue({
        cdn_enabled: true,
        cdn_branch: null,
        default_branch: 'main',
      }),
      createCDNBuild: vi.fn().mockResolvedValue({ id: 'build-1' }),
      updateCDNBuild,
    }))

    const handler = await loadCDNBuildTriggerHandler()
    await expect(handler(event)).resolves.toBe('stream-sent')
    await Promise.resolve()
    await Promise.resolve()

    expect(updateCDNBuild).toHaveBeenCalledWith('build-1', expect.objectContaining({
      status: 'success',
    }))
    expect(eventStreamState.stream.push).toHaveBeenCalledWith(expect.stringContaining('"phase":"upload"'))
    expect(eventStreamState.stream.push).toHaveBeenCalledWith(expect.stringContaining('"phase":"complete"'))
    expect(eventStreamState.stream.close).toHaveBeenCalledOnce()
    expect(eventStreamState.stream.onClosed).toHaveBeenCalledOnce()

    const emitMock = vi.mocked(globalThis.emitWebhookEvent as ReturnType<typeof vi.fn>)
    expect(emitMock).toHaveBeenCalledWith('project-1', 'workspace-1', 'cdn.build_complete', expect.objectContaining({
      buildId: 'build-1',
      status: 'success',
      filesUploaded: 2,
    }))
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

    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getProjectForWorkspace: vi.fn().mockResolvedValue(null),
      listCDNBuilds: vi.fn().mockResolvedValue([]),
    }))

    const handler = await loadCDNBuildsHandler()

    await expect(handler(event)).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})
