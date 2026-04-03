import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

function stubRouteGlobals(branch: string) {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', createErrorLike)
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
    user: { id: 'user-1' },
    accessToken: 'token-1',
  }))
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'workspaceId') return 'workspace-1'
    if (key === 'projectId') return 'project-1'
    if (key === 'branch') return branch
    return undefined
  }))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('useDatabaseProvider', vi.fn(() => ({
    getUserClient: vi.fn((accessToken: string) => {
      const userClient = (globalThis as typeof globalThis & {
        useSupabaseUserClient?: (token: string) => unknown
      }).useSupabaseUserClient
      return typeof userClient === 'function' ? userClient(accessToken) : {}
    }),
  })))
}

describe('branch moderation routes', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('blocks merge requests for non-contentrain branches', async () => {
    stubRouteGlobals('feature/direct-edit')
    vi.stubGlobal('resolveAgentPermissions', vi.fn())

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/merge.post')).default

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('blocks merge requests without reviewer permissions', async () => {
    stubRouteGlobals('cr/content/faq/en/1234567890-abcd')
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['list_branches'],
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/merge.post')).default

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('delegates merge operations to the content engine for valid contentrain branches', async () => {
    const mergeBranch = vi.fn().mockResolvedValue({
      merged: true,
      sha: 'merge-sha',
      pullRequestUrl: null,
    })

    stubRouteGlobals('cr/content/faq/en/1234567890-abcd')
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['merge_branch'],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {},
      contentRoot: '',
    }))
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({
      mergeBranch,
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/merge.post')).default
    const result = await handler({} as never)

    expect(mergeBranch).toHaveBeenCalledWith('cr/content/faq/en/1234567890-abcd')
    expect(result).toEqual({
      merged: true,
      sha: 'merge-sha',
      pullRequestUrl: null,
    })
  })

  it('delegates reject operations to the content engine for valid contentrain branches', async () => {
    const rejectBranch = vi.fn().mockResolvedValue(undefined)

    stubRouteGlobals('cr/content/faq/en/1234567890-abcd')
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['reject_branch'],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {},
      contentRoot: '',
    }))
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({
      rejectBranch,
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/reject.post')).default
    const result = await handler({} as never)

    expect(rejectBranch).toHaveBeenCalledWith('cr/content/faq/en/1234567890-abcd')
    expect(result).toEqual({ rejected: true })
  })
})
