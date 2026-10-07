import { beforeEach, describe, expect, it, vi } from 'vitest'

const providerState = vi.hoisted(() => ({
  databaseProvider: {
    requireWorkspaceRole: vi.fn(),
    getProjectMember: vi.fn(),
    getProjectForWorkspace: vi.fn(),
    listAuditLogs: vi.fn(),
  },
}))

async function loadActivityHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/activity.get')).default
}

describe('GET /projects/:projectId/activity — who sees which audit rows', () => {
  beforeEach(() => {
    const db = providerState.databaseProvider
    db.requireWorkspaceRole.mockReset()
    db.getProjectMember.mockReset()
    db.getProjectForWorkspace.mockReset().mockResolvedValue({ id: 'project-1' })
    db.listAuditLogs.mockReset().mockResolvedValue({
      data: [{ id: 'log-1', action: 'delete_comment', actor_id: 'user-9', table_name: 'comments', record_id: 'c-1', origin: 'app', created_at: '2026-10-07T00:00:00Z' }],
      total: 1,
    })
    vi.stubGlobal('useDatabaseProvider', () => providerState.databaseProvider)
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ accessToken: 'tok', user: { id: 'user-1' } }))
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => key === 'workspaceId' ? 'ws-1' : key === 'projectId' ? 'project-1' : undefined))
    vi.stubGlobal('getQuery', vi.fn().mockReturnValue({}))
  })

  it('a workspace member without access to the project is refused with 403 and reads nothing', async () => {
    providerState.databaseProvider.requireWorkspaceRole.mockResolvedValue('member')
    providerState.databaseProvider.getProjectMember.mockResolvedValue(null)
    const handler = await loadActivityHandler()

    await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 403 })
    expect(providerState.databaseProvider.listAuditLogs).not.toHaveBeenCalled()
  })

  it('a member of the project reads only the rows that name that project', async () => {
    providerState.databaseProvider.requireWorkspaceRole.mockResolvedValue('member')
    providerState.databaseProvider.getProjectMember.mockResolvedValue({ role: 'viewer' })
    const handler = await loadActivityHandler()

    await handler({} as never)

    expect(providerState.databaseProvider.listAuditLogs).toHaveBeenCalledWith('ws-1', expect.objectContaining({ projectId: 'project-1' }))
  })

  it.each(['owner', 'admin'])('a workspace %s keeps the whole workspace view', async (role) => {
    providerState.databaseProvider.requireWorkspaceRole.mockResolvedValue(role)
    const handler = await loadActivityHandler()

    const result = await handler({} as never) as { total: number }

    expect(result.total).toBe(1)
    expect(providerState.databaseProvider.getProjectMember).not.toHaveBeenCalled()
    const options = providerState.databaseProvider.listAuditLogs.mock.calls[0]![1] as { projectId?: string }
    expect(options.projectId).toBeUndefined()
  })
})
