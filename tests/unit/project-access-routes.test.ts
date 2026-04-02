import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

async function loadRequireProjectAccess() {
  return (await import('../../server/utils/db')).requireProjectAccess
}

async function loadBrainSyncHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/brain/sync.get')).default
}

async function loadBranchesHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/index.get')).default
}

async function loadBranchDiffHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/diff.get')).default
}

async function loadHealthHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/health.get')).default
}

function stubProjectRouteParams(route: 'brain' | 'branches' | 'diff' | 'health') {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'workspaceId') return 'workspace-1'
    if (key === 'projectId') return 'project-1'
    if (key === 'branch' && route === 'diff') return 'cr/content/posts/en/branch-1'
    return undefined
  }))
}

describe('project access route regression', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    {
      name: 'brain sync',
      route: 'brain' as const,
      loadHandler: loadBrainSyncHandler,
    },
    {
      name: 'branches list',
      route: 'branches' as const,
      loadHandler: loadBranchesHandler,
    },
    {
      name: 'branch diff',
      route: 'diff' as const,
      loadHandler: loadBranchDiffHandler,
    },
    {
      name: 'project health',
      route: 'health' as const,
      loadHandler: loadHealthHandler,
    },
  ])('rejects workspace members without project assignment for $name', async ({ route, loadHandler }) => {
    stubProjectRouteParams(route)
    vi.stubGlobal('requireProjectAccess', await loadRequireProjectAccess())
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      requireWorkspaceRole: vi.fn().mockResolvedValue('member'),
      getProjectMember: vi.fn().mockResolvedValue(null),
    }))

    const handler = await loadHandler()

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 403,
      message: 'project.access_denied',
    })
  })
})
