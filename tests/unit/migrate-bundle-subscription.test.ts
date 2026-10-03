import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const DAY = 24 * 60 * 60 * 1000
const now = new Date('2026-10-10T00:00:00Z')

const bundleGrant = (overrides: Record<string, unknown> = {}) => ({
  id: 'grant-1',
  kind: 'bundle',
  plan: 'pro',
  workspace_id: 'ws-1',
  redeemed_subscription_id: 'sub_1',
  bundle_target_product_id: 'prod_pro_y',
  bundle_applied_at: null,
  ...overrides,
})

describe('bundle subscription: move to the list product', () => {
  let db: Record<string, ReturnType<typeof vi.fn>>
  let payment: { moveBundleSubscriptionToList: ReturnType<typeof vi.fn> }
  let errorLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    db = {
      markMigrateGrantRedeemed: vi.fn().mockResolvedValue(undefined),
      getMigrateGrantById: vi.fn().mockResolvedValue(bundleGrant()),
      markMigrateBundleApplied: vi.fn().mockResolvedValue(undefined),
      listPendingMigrateBundles: vi.fn().mockResolvedValue([]),
      getActivePaymentAccount: vi.fn().mockResolvedValue(null),
    }
    payment = { moveBundleSubscriptionToList: vi.fn().mockResolvedValue({ productId: 'prod_pro_y', alreadyOnList: false }) }
    vi.stubGlobal('useDatabaseProvider', () => db)
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorLog.mockRestore()
    vi.unstubAllGlobals()
  })

  const load = () => import('../../server/utils/migrate-bundle-subscription')

  it('moves the subscription and records it, once', async () => {
    const { applyBundleListProduct } = await load()
    expect(await applyBundleListProduct(payment as never, bundleGrant() as never, 'sub_1')).toBe('applied')
    expect(payment.moveBundleSubscriptionToList).toHaveBeenCalledWith('sub_1', 'pro')
    expect(db.markMigrateBundleApplied).toHaveBeenCalledWith('grant-1')
  })

  it.each([
    ['a trial grant', { kind: 'trial' }],
    ['a bundle with no target product', { bundle_target_product_id: null }],
    ['a bundle already moved', { bundle_applied_at: '2026-10-01T00:00:00Z' }],
  ])('leaves %s alone', async (_label, overrides) => {
    const { applyBundleListProduct } = await load()
    expect(await applyBundleListProduct(payment as never, bundleGrant(overrides) as never, 'sub_1')).toBe('skipped')
    expect(payment.moveBundleSubscriptionToList).not.toHaveBeenCalled()
  })

  it('a failed move is logged and left pending (never thrown, never marked applied)', async () => {
    payment.moveBundleSubscriptionToList.mockRejectedValue(new Error('polar down'))
    const { applyBundleListProduct } = await load()
    expect(await applyBundleListProduct(payment as never, bundleGrant() as never, 'sub_1')).toBe('pending')
    expect(db.markMigrateBundleApplied).not.toHaveBeenCalled()
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('move to list product failed'), expect.any(Error))
  })

  it('redeeming marks the grant used and then moves a bundle; a plain grant is only marked', async () => {
    const { redeemMigrateGrant } = await load()
    await redeemMigrateGrant(payment as never, 'grant-1', 'sub_1')
    expect(db.markMigrateGrantRedeemed).toHaveBeenCalledWith('grant-1', 'sub_1')
    expect(payment.moveBundleSubscriptionToList).toHaveBeenCalledTimes(1)

    payment.moveBundleSubscriptionToList.mockClear()
    db.getMigrateGrantById.mockResolvedValue(bundleGrant({ kind: 'trial' }))
    await redeemMigrateGrant(payment as never, 'grant-2', 'sub_2')
    expect(db.markMigrateGrantRedeemed).toHaveBeenCalledWith('grant-2', 'sub_2')
    expect(payment.moveBundleSubscriptionToList).not.toHaveBeenCalled()
  })

  describe('reconciler', () => {
    it('retries pending moves and counts those it fixed', async () => {
      db.listPendingMigrateBundles.mockResolvedValue([bundleGrant(), bundleGrant({ id: 'grant-2', redeemed_subscription_id: 'sub_2' })])
      const { reconcileMigrateBundles } = await load()
      expect(await reconcileMigrateBundles(payment as never, now)).toEqual({ checked: 2, applied: 2, stillPending: 0, alarms: 0 })
    })

    it('stays quiet about a failing move more than 30 days from renewal, and alarms within 30', async () => {
      payment.moveBundleSubscriptionToList.mockRejectedValue(new Error('polar down'))
      db.listPendingMigrateBundles.mockResolvedValue([bundleGrant()])
      const { reconcileMigrateBundles } = await load()

      db.getActivePaymentAccount.mockResolvedValue({ current_period_end: new Date(now.getTime() + 60 * DAY).toISOString() })
      expect(await reconcileMigrateBundles(payment as never, now)).toMatchObject({ stillPending: 1, alarms: 0 })
      expect(errorLog.mock.calls.some(call => String(call[0]).includes('ALARM'))).toBe(false)

      db.getActivePaymentAccount.mockResolvedValue({ current_period_end: new Date(now.getTime() + 29 * DAY).toISOString() })
      expect(await reconcileMigrateBundles(payment as never, now)).toMatchObject({ stillPending: 1, alarms: 1 })
      expect(errorLog.mock.calls.some(call => String(call[0]).includes('[migrate-bundle] ALARM grant grant-1'))).toBe(true)
    })

    it('alarms when the renewal date is unknown', async () => {
      payment.moveBundleSubscriptionToList.mockRejectedValue(new Error('polar down'))
      db.listPendingMigrateBundles.mockResolvedValue([bundleGrant()])
      const { reconcileMigrateBundles } = await load()
      expect(await reconcileMigrateBundles(payment as never, now)).toMatchObject({ alarms: 1 })
    })
  })
})
