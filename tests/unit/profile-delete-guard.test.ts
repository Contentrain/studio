import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string, data?: unknown }) {
  return Object.assign(new Error(input.message), input)
}

const ME = 'user-1'

describe('DELETE /api/profile', () => {
  const deleteUser = vi.fn()
  const clearServerSession = vi.fn()

  function setup(opts: { secondary?: unknown[], owned?: unknown[], accounts?: Record<string, unknown> }) {
    const db = {
      listOwnedSecondaryWorkspacesWithMembers: vi.fn().mockResolvedValue(opts.secondary ?? []),
      listUserWorkspaces: vi.fn().mockResolvedValue(opts.owned ?? [{ id: 'ws-1', owner_id: ME }]),
      listWorkspaceProjectsAdmin: vi.fn().mockResolvedValue([]),
      getActivePaymentAccount: vi.fn(async (id: string) => opts.accounts?.[id] ?? null),
    }
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db))
    return db
  }

  beforeEach(() => {
    vi.resetModules()
    deleteUser.mockReset()
    clearServerSession.mockReset()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: ME }, accessToken: 'token' }))
    vi.stubGlobal('useAuthProvider', vi.fn().mockReturnValue({ deleteUser }))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue(null))
    vi.stubGlobal('clearServerSession', clearServerSession)
    vi.stubGlobal('reportDataLossRisk', vi.fn())
  })

  afterEach(() => vi.unstubAllGlobals())

  async function run() {
    return (await import('../../server/api/profile/index.delete')).default({} as never)
  }

  it('refuses while an owned workspace still has other members, and deletes nothing', async () => {
    setup({ secondary: [{ id: 'ws-team', workspace_members: [{ user_id: ME }, { user_id: 'someone' }] }] })
    await expect(run()).rejects.toMatchObject({
      statusCode: 409,
      message: 'account.transfer_required',
      data: { code: 'ownership_transfer_required', workspaces: ['ws-team'] },
    })
    expect(deleteUser).not.toHaveBeenCalled()
    expect(clearServerSession).not.toHaveBeenCalled()
  })

  it.each(['active', 'trialing', 'past_due'])('refuses while an owned workspace has a %s subscription', async (status) => {
    setup({ accounts: { 'ws-1': { subscription_id: 'sub_1', subscription_status: status } } })
    await expect(run()).rejects.toMatchObject({
      statusCode: 409,
      message: 'account.subscription_active',
      data: { code: 'active_subscription', workspaces: ['ws-1'] },
    })
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it.each(['active', 'trialing', 'past_due'])('a %s subscription already set to cancel at period end does not block', async (status) => {
    setup({ accounts: { 'ws-1': { subscription_id: 'sub_1', subscription_status: status, cancel_at_period_end: true } } })
    await expect(run()).resolves.toEqual({ deleted: true })
    expect(deleteUser).toHaveBeenCalledWith(ME)
  })

  it.each(['active', 'trialing'])('a %s subscription with cancel_at_period_end false still blocks', async (status) => {
    setup({ accounts: { 'ws-1': { subscription_id: 'sub_1', subscription_status: status, cancel_at_period_end: false } } })
    await expect(run()).rejects.toMatchObject({ statusCode: 409, data: { code: 'active_subscription' } })
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('a canceled subscription does not block', async () => {
    setup({ accounts: { 'ws-1': { subscription_id: 'sub_1', subscription_status: 'canceled' } } })
    await expect(run()).resolves.toEqual({ deleted: true })
    expect(deleteUser).toHaveBeenCalledWith(ME)
  })

  it('a clean account is deleted and the session is cleared', async () => {
    setup({ secondary: [{ id: 'ws-solo', workspace_members: [{ user_id: ME }] }] })
    await expect(run()).resolves.toEqual({ deleted: true })
    expect(deleteUser).toHaveBeenCalledWith(ME)
    expect(clearServerSession).toHaveBeenCalledTimes(1)
  })

  it('the list the screen uses is the same blocking set the delete refuses on', async () => {
    setup({ secondary: [
      { id: 'ws-team', workspace_members: [{ user_id: ME }, { user_id: 'someone' }] },
      { id: 'ws-solo', workspace_members: [{ user_id: ME }] },
    ] })
    const listed = await (await import('../../server/api/profile/owned-workspaces.get')).default({} as never) as Array<{ id: string }>
    expect(listed.map(w => w.id)).toEqual(['ws-team'])
  })

  it('the ending-plans list names the period end of a plan already set to end, and only that', async () => {
    setup({
      owned: [{ id: 'ws-1', owner_id: ME }, { id: 'ws-2', owner_id: ME }, { id: 'ws-3', owner_id: ME }],
      accounts: {
        'ws-1': { subscription_id: 'sub_1', subscription_status: 'active', cancel_at_period_end: true, current_period_end: '2027-01-15T12:00:00Z' },
        'ws-2': { subscription_id: 'sub_2', subscription_status: 'active', cancel_at_period_end: false, current_period_end: '2027-02-01T00:00:00Z' },
        'ws-3': { subscription_id: 'sub_3', subscription_status: 'canceled', cancel_at_period_end: true, current_period_end: '2026-09-01T00:00:00Z' },
      },
    })
    const ending = await (await import('../../server/api/profile/ending-plans.get')).default({} as never)
    expect(ending).toEqual([{ workspace_id: 'ws-1', ends_at: '2027-01-15T12:00:00.000Z' }])
  })
})
