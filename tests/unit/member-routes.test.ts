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
    const workspaceMemberSelectSingle = vi.fn().mockResolvedValue({ data: { role: 'member' } })
    const workspaceMemberSelectChain2 = {
      single: workspaceMemberSelectSingle,
    }
    const workspaceMemberSelectChain1 = {
      single: workspaceMemberSelectSingle,
      eq: vi.fn(() => workspaceMemberSelectChain2),
    }
    const projectMemberInsertChain = {
      select: vi.fn(() => ({
        single: vi.fn().mockResolvedValue({
          data: {
            id: 'project-member-1',
            role: 'editor',
            specific_models: false,
            allowed_models: [],
          },
          error: null,
        }),
      })),
    }
    const projectMemberDeleteChain = {
      eq: vi.fn(() => ({
        eq: vi.fn().mockResolvedValue({ error: null }),
      })),
    }
    const userClient = {
      from: vi.fn((table: string) => {
        if (table === 'workspace_members') {
          return {
            select: vi.fn(() => workspaceMemberSelectChain1),
          }
        }

        if (table === 'project_members') {
          return {
            select: vi.fn(() => workspaceMemberSelectChain1),
            insert: vi.fn(() => projectMemberInsertChain),
            delete: vi.fn(() => projectMemberDeleteChain),
          }
        }

        if (table === 'workspaces') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { plan: 'free', name: 'Acme', slug: 'acme' },
                }),
              })),
            })),
          }
        }

        throw new Error(`Unexpected table: ${table}`)
      }),
    }
    const adminClient = {
      from: vi.fn((table: string) => {
        if (table === 'projects') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn().mockResolvedValue({ data: { id: 'project-1' } }),
                })),
              })),
            })),
          }
        }

        if (table === 'project_members') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({
                data: [
                  { project_id: 'project-2' },
                  { project_id: 'project-outside' },
                ],
              }),
            })),
          }
        }

        throw new Error(`Unexpected table: ${table}`)
      }),
    }
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      listWorkspaceMembers: vi.fn().mockResolvedValue([{ id: 'member-1' }]),
      getWorkspaceForUser: vi.fn().mockResolvedValue({ plan: 'free', name: 'Acme', slug: 'acme' }),
      createWorkspaceMember: vi.fn().mockResolvedValue({ id: 'member-2' }),
      updateWorkspaceMemberRole: vi.fn().mockResolvedValue({ id: 'member-3', role: 'admin' }),
      deleteWorkspaceMember: vi.fn().mockResolvedValue(undefined),
      getWorkspaceMember: vi.fn().mockResolvedValue({
        id: 'member-4',
        invited_email: 'invitee@example.com',
        accepted_at: null,
      }),
      updateWorkspaceMemberInvitedAt: vi.fn().mockResolvedValue(undefined),
      requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
      listProjectMembers: vi.fn().mockResolvedValue([{ id: 'project-member-1' }]),
      getProjectForWorkspace: vi.fn().mockResolvedValue({ id: 'project-1' }),
      getWorkspaceById: vi.fn().mockResolvedValue({ plan: 'free', name: 'Acme', slug: 'acme' }),
      ensureWorkspaceMember: vi.fn().mockResolvedValue(undefined),
      createProjectMember: vi.fn().mockResolvedValue({
        id: 'project-member-1',
        role: 'editor',
        specific_models: false,
        allowed_models: [],
      }),
      deleteProjectMember: vi.fn().mockResolvedValue(undefined),
      getUserClient: vi.fn(() => userClient),
      getAdminClient: vi.fn(() => adminClient),
    }))
    vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({
      allowed: true,
      remaining: 2,
      retryAfterMs: 0,
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('free'))
    vi.stubGlobal('getPlanLimit', vi.fn().mockReturnValue(2))
    vi.stubGlobal('inviteOrLookupUser', vi.fn().mockResolvedValue({ userId: 'user-2', isNewUser: true }))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
    vi.stubGlobal('normalizeEnterpriseProjectMemberAccess', vi.fn().mockResolvedValue({
      role: 'editor',
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('useAuthProvider', vi.fn().mockReturnValue({
      inviteUserByEmail: vi.fn().mockResolvedValue({ userId: 'user-2' }),
    }))
    vi.stubGlobal('useEmailProvider', vi.fn().mockReturnValue(null))
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      public: { siteUrl: 'https://studio.example.com' },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists workspace members through the admin client', async () => {
    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/members/index.get')).default
    const result = await handler({} as never)

    expect(result).toEqual([{ id: 'member-1' }])
    expect(useDatabaseProvider().listWorkspaceMembers).toHaveBeenCalledWith('token-1', 'user-1', 'workspace-1')
  })

  it('blocks workspace invites when the seat limit is reached', async () => {
    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      email: 'new@example.com',
      role: 'member',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      listWorkspaceMembers: vi.fn().mockResolvedValue([{ id: '1' }, { id: '2' }]),
      getWorkspaceForUser: vi.fn().mockResolvedValue({ plan: 'free', name: 'Acme', slug: 'acme' }),
      createWorkspaceMember: vi.fn(),
      requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/members/index.post')).default

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('creates workspace members through the database provider boundary', async () => {
    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      email: 'new@example.com',
      role: 'member',
    }))
    vi.stubGlobal('getPlanLimit', vi.fn().mockReturnValue(10))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/members/index.post')).default
    const result = await handler({} as never)

    expect(result).toEqual({ id: 'member-2' })
    expect(useDatabaseProvider().createWorkspaceMember).toHaveBeenCalledWith('token-1', 'user-1', {
      workspaceId: 'workspace-1',
      memberUserId: 'user-2',
      role: 'member',
      invitedEmail: 'new@example.com',
      acceptedAt: null,
    })
  })

  it('updates workspace member roles through the database provider boundary', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'memberId') return 'member-1'
      return undefined
    }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      role: 'admin',
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/members/[memberId].patch')).default
    const result = await handler({} as never)

    expect(result).toEqual({ id: 'member-3', role: 'admin' })
    expect(useDatabaseProvider().updateWorkspaceMemberRole).toHaveBeenCalledWith('token-1', 'user-1', 'workspace-1', 'member-1', 'admin')
  })

  it('deletes workspace members through the database provider boundary', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'memberId') return 'member-1'
      return undefined
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/members/[memberId].delete')).default
    const result = await handler({} as never)

    expect(result).toEqual({ deleted: true })
    expect(useDatabaseProvider().deleteWorkspaceMember).toHaveBeenCalledWith('token-1', 'user-1', 'workspace-1', 'member-1')
  })

  it('resends workspace invites through the database provider boundary', async () => {
    const inviteUserByEmail = vi.fn().mockRejectedValue(new Error('confirmed'))
    const sendEmail = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'memberId') return 'member-4'
      return undefined
    }))
    vi.stubGlobal('useAuthProvider', vi.fn().mockReturnValue({ inviteUserByEmail }))
    vi.stubGlobal('useEmailProvider', vi.fn().mockReturnValue({ sendEmail }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/members/[memberId]/resend.post')).default
    const result = await handler({} as never)

    expect(result).toEqual({ resent: true })
    expect(inviteUserByEmail).toHaveBeenCalledWith('invitee@example.com', {
      redirectTo: 'https://studio.example.com/auth/callback?workspace=acme',
    })
    expect(sendEmail).toHaveBeenCalledOnce()
    expect(useDatabaseProvider().updateWorkspaceMemberInvitedAt).toHaveBeenCalledWith(
      'token-1',
      'user-1',
      'workspace-1',
      'member-4',
      expect.any(String),
    )
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

  it('degrades premium project roles to editor on free plans', async () => {
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
    const result = await handler({} as never)

    expect(result).toMatchObject({
      role: 'editor',
      specific_models: false,
      allowed_models: [],
    })
  })

  it('deletes project members only after validating workspace ownership', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'memberId') return 'member-1'
      return undefined
    }))

    const deleteProjectMember = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
      getProjectForWorkspace: vi.fn().mockResolvedValue({ id: 'project-1' }),
      deleteProjectMember,
      getUserClient: vi.fn(),
      getAdminClient: vi.fn(),
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/members/[memberId].delete')).default
    const result = await handler({} as never)

    expect(result).toEqual({ deleted: true })
    expect(deleteProjectMember).toHaveBeenCalledWith('project-1', 'member-1')
  })
})
