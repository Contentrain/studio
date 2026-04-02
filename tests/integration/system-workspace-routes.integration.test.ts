import { describe, expect, it, vi } from 'vitest'

async function loadHealthHandler() {
  return (await import('../../server/api/health.get')).default
}

async function loadWorkspaceGetHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/index.get')).default
}

async function loadWorkspacePatchHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/index.patch')).default
}

async function loadWorkspaceCreateHandler() {
  return (await import('../../server/api/workspaces/index.post')).default
}

async function loadWorkspaceListHandler() {
  return (await import('../../server/api/workspaces/index.get')).default
}

async function loadWorkspaceMemberDeleteHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/members/[memberId].delete')).default
}

async function loadWorkspaceMemberPatchHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/members/[memberId].patch')).default
}

describe('system and workspace route integration', () => {
  it('returns a healthy timestamped status payload', async () => {
    const handler = await loadHealthHandler()
    const payload = await handler({} as never)

    expect(payload.status).toBe('ok')
    expect(Date.parse(payload.timestamp)).not.toBeNaN()
  })

  it('lists the authenticated user workspaces', async () => {
    const listUserWorkspaces = vi.fn().mockResolvedValue([
      { id: 'workspace-1', slug: 'acme', plan: 'pro' },
      { id: 'workspace-2', slug: 'docs', plan: 'starter' },
    ])

    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      listUserWorkspaces,
    }))

    const handler = await loadWorkspaceListHandler()
    const result = await handler({} as never)

    expect(result).toEqual([
      { id: 'workspace-1', slug: 'acme', plan: 'pro' },
      { id: 'workspace-2', slug: 'docs', plan: 'starter' },
    ])
    expect(listUserWorkspaces).toHaveBeenCalledWith('token-1', 'user-1')
  })

  it('loads workspace details with nested member profile data', async () => {
    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getWorkspaceDetailForUser: vi.fn().mockResolvedValue({
        id: 'workspace-1',
        name: 'Acme',
        workspace_members: [{ id: 'member-1', role: 'owner' }],
      }),
    }))

    const handler = await loadWorkspaceGetHandler()
    const result = await handler({} as never)

    expect(result).toEqual({
      id: 'workspace-1',
      name: 'Acme',
      workspace_members: [{ id: 'member-1', role: 'owner' }],
    })
  })

  it('normalizes workspace slugs on patch and returns 409 for collisions', async () => {
    const slugify = vi.fn().mockReturnValue('acme-studio')
    const updateWorkspaceForUser = vi.fn()
      .mockResolvedValueOnce({
        id: 'workspace-1',
        name: 'Acme Studio',
        slug: 'acme-studio',
      })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { statusCode: 409 }))
    vi.stubGlobal('slugify', slugify)
    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      updateWorkspaceForUser,
    }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      name: 'Acme Studio',
      slug: 'Acme Studio',
    }))

    const handler = await loadWorkspacePatchHandler()

    const success = await handler({} as never)

    expect(success).toEqual({
      id: 'workspace-1',
      name: 'Acme Studio',
      slug: 'acme-studio',
    })
    expect(slugify).toHaveBeenCalledWith('Acme Studio')

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it('creates secondary workspaces with trial period', async () => {
    const createWorkspace = vi.fn().mockResolvedValue({
      id: 'workspace-2',
      slug: 'acme-team',
      type: 'secondary',
    })
    const updateWorkspace = vi.fn().mockResolvedValue({})

    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('slugify', vi.fn().mockReturnValue('acme-team'))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      createWorkspace,
      updateWorkspace,
    }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      name: 'Acme Team',
      slug: 'Acme Team',
    }))

    const handler = await loadWorkspaceCreateHandler()
    const result = await handler({} as never)

    expect(result).toEqual({
      id: 'workspace-2',
      slug: 'acme-team',
      type: 'secondary',
    })
    expect(createWorkspace).toHaveBeenCalledWith('token-1', {
      ownerId: 'user-1',
      name: 'Acme Team',
      slug: 'acme-team',
      type: 'secondary',
    })
    // Trial is now handled by Stripe — no updateWorkspace call for trial_ends_at
    expect(updateWorkspace).not.toHaveBeenCalled()
  })

  it('blocks workspace-owner removal', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'owner-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      deleteWorkspaceMember: vi.fn().mockRejectedValue(Object.assign(new Error('members.cannot_remove_owner'), {
        statusCode: 400,
        message: 'members.cannot_remove_owner',
      })),
    }))
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'memberId') return 'member-1'
      return undefined
    }))

    const handler = await loadWorkspaceMemberDeleteHandler()
    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('allows member role updates by workspace owners', async () => {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'owner-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      updateWorkspaceMemberRole: vi.fn().mockResolvedValue({
        id: 'member-2',
        role: 'admin',
      }),
    }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      role: 'admin',
    }))
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'memberId') return 'member-2'
      return undefined
    }))

    const handler = await loadWorkspaceMemberPatchHandler()
    const result = await handler({} as never)

    expect(result).toEqual({
      id: 'member-2',
      role: 'admin',
    })
  })
})
