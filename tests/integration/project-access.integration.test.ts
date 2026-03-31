import { describe, expect, it, vi } from 'vitest'

async function loadWorkspaceMembersHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/members/index.get')).default
}

async function loadProjectsHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/index.get')).default
}

async function loadProjectMemberCreateHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/members/index.post')).default
}

async function loadProjectMemberDeleteHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/members/[memberId].delete')).default
}

describe('project and membership access integration', () => {
  it('blocks regular members from loading the full workspace member roster', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      listWorkspaceMembers: vi.fn().mockRejectedValue(Object.assign(new Error('Requires owner or admin role'), {
        statusCode: 403,
        message: 'Requires owner or admin role',
      })),
    }))

    const handler = await loadWorkspaceMembersHandler()
    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('returns only explicitly assigned projects for workspace members', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getWorkspaceMemberRole: vi.fn().mockResolvedValue('member'),
      listUserAssignedProjectIds: vi.fn().mockResolvedValue(['project-2', 'project-outside']),
      listWorkspaceProjectsByIds: vi.fn().mockResolvedValue([
        { id: 'project-2', workspace_id: 'workspace-1', repo_full_name: 'acme/site' },
      ]),
    }))

    const handler = await loadProjectsHandler()
    const result = await handler({} as never)

    expect(result).toEqual([
      { id: 'project-2', workspace_id: 'workspace-1', repo_full_name: 'acme/site' },
    ])
  })

  it('rejects project member invites routed through a foreign workspace path', async () => {
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
      requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
      getProjectForWorkspace: vi.fn().mockResolvedValue(null),
    }))
    vi.stubGlobal('inviteOrLookupUser', vi.fn())

    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      email: 'reviewer@example.com',
      role: 'editor',
    }))

    const handler = await loadProjectMemberCreateHandler()
    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('rejects project member removal through a foreign workspace path', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-foreign'
      if (key === 'memberId') return 'member-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
      getProjectForWorkspace: vi.fn().mockResolvedValue(null),
    }))

    const handler = await loadProjectMemberDeleteHandler()
    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})
