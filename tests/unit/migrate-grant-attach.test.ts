import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: 'subscription' }) }))

const grantRow = {
  id: 'grant-1', order_id: 'ord_123', user_id: 'user-1', kind: 'trial', plan: 'pro', trial_days: 60,
  workspace_id: null, bound_at: null, redeemed_at: null, revoked_at: null,
}
const account = (over: Record<string, unknown> = {}) => ({
  subscription_id: 'sub_1', subscription_status: 'active', plan: 'pro', current_period_end: '2027-01-01T00:00:00Z',
  trial_ends_at: null, cancel_at_period_end: false, grace_period_ends_at: null, plugin_metadata: {}, ...over,
})

describe('POST /api/migrate/grants/:grantId/attach', () => {
  let db: Record<string, ReturnType<typeof vi.fn>>

  const attach = async () => ((await import('../../server/api/migrate/grants/[grantId]/attach.post')).default as (e: unknown) => Promise<unknown>)({})

  beforeEach(() => {
    vi.resetModules()
    db = {
      getMigrateGrantForUser: vi.fn().mockResolvedValue(grantRow),
      getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1', slug: 'acme', name: 'Acme', type: 'secondary', plan: 'pro', overage_settings: {} }),
      getActivePaymentAccount: vi.fn().mockResolvedValue(account()),
      bindMigrateGrantWorkspace: vi.fn().mockResolvedValue({ ...grantRow, workspace_id: 'ws-1', bound_at: '2026-10-03T10:00:00Z' }),
      markMigrateGrantRedeemed: vi.fn().mockResolvedValue(undefined),
    }
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', (key: string) => key)
    vi.stubGlobal('requireAuth', () => ({ user: { id: 'user-1' }, accessToken: 't' }))
    vi.stubGlobal('readBody', () => Promise.resolve({ workspaceId: 'ws-1' }))
    vi.stubGlobal('getRouterParam', () => 'grant-1')
    vi.stubGlobal('useRuntimeConfig', () => ({ migrate: { claimPublicKey: '-----BEGIN PUBLIC KEY-----\\nMCow\\n-----END PUBLIC KEY-----' } }))
    vi.stubGlobal('useDatabaseProvider', () => db)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('adds the site to a workspace whose paid plan covers the grant: bound and used, no subscription of its own', async () => {
    expect(await attach()).toEqual({ ok: true, workspaceSlug: 'acme' })
    expect(db.bindMigrateGrantWorkspace).toHaveBeenCalledWith('grant-1', 'ws-1')
    expect(db.markMigrateGrantRedeemed).toHaveBeenCalledWith('grant-1', null)
  })

  it('treats Enterprise as covering Pro', async () => {
    db.getActivePaymentAccount.mockResolvedValue(account({ plan: 'enterprise' }))
    db.getWorkspaceForUser.mockResolvedValue({ id: 'ws-1', slug: 'acme', type: 'secondary', plan: 'enterprise', overage_settings: {} })
    await expect(attach()).resolves.toMatchObject({ ok: true })
  })

  it('refuses a plan below the grant\'s and changes nothing', async () => {
    db.getActivePaymentAccount.mockResolvedValue(account({ plan: 'starter' }))
    db.getWorkspaceForUser.mockResolvedValue({ id: 'ws-1', slug: 'acme', type: 'secondary', plan: 'starter', overage_settings: {} })
    await expect(attach()).rejects.toMatchObject({ statusCode: 409, message: 'migrate.attach_plan_too_small' })
    expect(db.bindMigrateGrantWorkspace).not.toHaveBeenCalled()
    expect(db.markMigrateGrantRedeemed).not.toHaveBeenCalled()
  })

  it('refuses a plan that is ending (active, set to cancel at the period\'s end)', async () => {
    db.getActivePaymentAccount.mockResolvedValue(account({ cancel_at_period_end: true }))
    await expect(attach()).rejects.toMatchObject({ statusCode: 409, message: 'migrate.attach_no_plan' })
    expect(db.bindMigrateGrantWorkspace).not.toHaveBeenCalled()
    expect(db.markMigrateGrantRedeemed).not.toHaveBeenCalled()
  })

  it('refuses a past_due plan: fix billing first', async () => {
    db.getActivePaymentAccount.mockResolvedValue(account({ subscription_status: 'past_due', grace_period_ends_at: '2099-01-01T00:00:00Z' }))
    await expect(attach()).rejects.toMatchObject({ statusCode: 409, message: 'migrate.attach_past_due' })
    expect(db.bindMigrateGrantWorkspace).not.toHaveBeenCalled()
    expect(db.markMigrateGrantRedeemed).not.toHaveBeenCalled()
  })

  it('refuses a workspace with no running paid plan (none, or still in trial)', async () => {
    db.getActivePaymentAccount.mockResolvedValue(null)
    await expect(attach()).rejects.toMatchObject({ statusCode: 409, message: 'migrate.attach_no_plan' })
    db.getActivePaymentAccount.mockResolvedValue(account({ subscription_status: 'trialing', trial_ends_at: '2027-01-01T00:00:00Z' }))
    await expect(attach()).rejects.toMatchObject({ statusCode: 409, message: 'migrate.attach_no_plan' })
    expect(db.markMigrateGrantRedeemed).not.toHaveBeenCalled()
  })

  it.each([
    [{ redeemed_at: '2026-10-03T10:00:00Z' }, 'migrate.grant_used'],
    [{ revoked_at: '2026-10-03T10:00:00Z' }, 'migrate.grant_revoked'],
    [{ kind: 'bundle' }, 'migrate.grant_bundle'],
    [{ bound_at: '2026-10-03T10:00:00Z', workspace_id: 'ws-2' }, 'migrate.grant_bound_elsewhere'],
  ])('refuses grant %o', async (over, key) => {
    db.getMigrateGrantForUser.mockResolvedValue({ ...grantRow, ...over })
    await expect(attach()).rejects.toMatchObject({ statusCode: 409, message: key })
    expect(db.markMigrateGrantRedeemed).not.toHaveBeenCalled()
  })

  it('needs an owner or admin of the workspace, and a grant of the caller\'s', async () => {
    db.getWorkspaceForUser.mockResolvedValue(null)
    await expect(attach()).rejects.toMatchObject({ statusCode: 403 })
    db.getMigrateGrantForUser.mockResolvedValue(null)
    await expect(attach()).rejects.toMatchObject({ statusCode: 404 })
  })
})
