import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

describe('member routes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: { plan: 'free' } }),
          })),
        })),
      })),
    }))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: { id: 'project-1' } }),
            })),
            single: vi.fn().mockResolvedValue({ data: { id: 'project-1' } }),
          })),
        })),
      })),
    }))
    vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('owner'))
    vi.stubGlobal('listWorkspaceMembers', vi.fn().mockResolvedValue([{ id: 'member-1' }]))
    vi.stubGlobal('listProjectMembers', vi.fn().mockResolvedValue([{ id: 'project-member-1' }]))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('free'))
    vi.stubGlobal('getPlanLimit', vi.fn().mockReturnValue(2))
    vi.stubGlobal('inviteOrLookupUser', vi.fn().mockResolvedValue('user-2'))
    vi.stubGlobal('ensureWorkspaceMember', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists workspace members through the admin client', async () => {
    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/members/index.get')).default
    const result = await handler({} as never)

    expect(result).toEqual([{ id: 'member-1' }])
  })

  it('blocks workspace invites when the seat limit is reached', async () => {
    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      email: 'new@example.com',
      role: 'member',
    }))
    vi.stubGlobal('listWorkspaceMembers', vi.fn().mockResolvedValue([{ id: '1' }, { id: '2' }]))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/members/index.post')).default

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Team member limit reached (2). Upgrade your plan to invite more members.',
    })
  })

  it('lists project members only when the project belongs to the workspace', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/members/index.get')).default
    const result = await handler({} as never)

    expect(result).toEqual([{ id: 'project-member-1' }])
  })

  it('blocks project reviewer assignment on free plans', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      email: 'reviewer@example.com',
      role: 'reviewer',
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/members/index.post')).default

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Reviewer role requires Pro plan or higher',
    })
  })
})
