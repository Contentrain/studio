import { describe, expect, it, vi } from 'vitest'
import {
  accountsMissingCompanion,
  cancelCompanionSubscription,
  companionSubscriptionIdOf,
  openCompanionSubscription,
  reconcileCompanionSubscriptions,
} from '../../server/utils/companion-subscription'

const yearlyRow = (over: Record<string, unknown> = {}) => ({
  workspace_id: 'ws-1', customer_id: 'cus_1', subscription_id: 'sub_1', subscription_status: 'active', plan: 'pro',
  current_period_start: '2026-10-01T00:00:00Z', current_period_end: '2027-10-01T00:00:00Z', plugin_metadata: {},
  ...over,
})

const provider = (over: Record<string, unknown> = {}) => ({
  cancelSubscription: vi.fn().mockResolvedValue('canceled'),
  ensureCompanionSubscription: vi.fn().mockResolvedValue({ subscriptionId: 'sub_c1', created: true }),
  ...over,
}) as never

describe('companionSubscriptionIdOf', () => {
  it('reads the stored id and treats an emptied one as none', () => {
    expect(companionSubscriptionIdOf({ companion_subscription_id: 'sub_c1' })).toBe('sub_c1')
    expect(companionSubscriptionIdOf({ companion_subscription_id: '' })).toBeNull()
    expect(companionSubscriptionIdOf(null)).toBeNull()
    expect(companionSubscriptionIdOf({})).toBeNull()
  })
})

describe('openCompanionSubscription', () => {
  const args = { workspaceId: 'ws-1', plan: 'pro', customerId: 'cus_1', subscriptionId: 'sub_1', productId: 'prod_pro_y' }

  it('records the companion on the account through the single-key write', async () => {
    const db = { setPaymentAccountMetadataKey: vi.fn().mockResolvedValue(true) }
    const p = provider()
    await openCompanionSubscription(p, db, args)
    expect((p as { ensureCompanionSubscription: ReturnType<typeof vi.fn> }).ensureCompanionSubscription).toHaveBeenCalledWith({
      workspaceId: 'ws-1', plan: 'pro', customerId: 'cus_1', parentSubscriptionId: 'sub_1', parentProductId: 'prod_pro_y',
    })
    expect(db.setPaymentAccountMetadataKey).toHaveBeenCalledWith({ workspaceId: 'ws-1', key: 'companion_subscription_id', value: 'sub_c1', when: 'different' })
  })

  it('does nothing when the provider has none for this subscription (off, monthly plan)', async () => {
    const db = { setPaymentAccountMetadataKey: vi.fn() }
    await openCompanionSubscription(provider({ ensureCompanionSubscription: vi.fn().mockResolvedValue(null) }), db, args)
    expect(db.setPaymentAccountMetadataKey).not.toHaveBeenCalled()
  })

  it('does nothing for a provider without companions, and for a plan that is not billable', async () => {
    const db = { setPaymentAccountMetadataKey: vi.fn() }
    await openCompanionSubscription(provider({ ensureCompanionSubscription: undefined }), db, args)
    await openCompanionSubscription(provider(), db, { ...args, plan: 'free' })
    expect(db.setPaymentAccountMetadataKey).not.toHaveBeenCalled()
  })

  it('never throws: a failure is an ALARM in the log and the reconciler retries', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = { setPaymentAccountMetadataKey: vi.fn() }
    await expect(openCompanionSubscription(provider({ ensureCompanionSubscription: vi.fn().mockRejectedValue(new Error('polar down')) }), db, args)).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[companion] ALARM'), expect.any(Error))
    log.mockRestore()
  })
})

describe('cancelCompanionSubscription', () => {
  it('cancels the recorded companion', async () => {
    const p = provider()
    expect(await cancelCompanionSubscription(p, { companion_subscription_id: 'sub_c1' }, 'test')).toBe(true)
    expect((p as { cancelSubscription: ReturnType<typeof vi.fn> }).cancelSubscription).toHaveBeenCalledWith('sub_c1')
  })

  it('has nothing to cancel without one', async () => {
    const p = provider()
    expect(await cancelCompanionSubscription(p, {}, 'test')).toBe(false)
    expect((p as { cancelSubscription: ReturnType<typeof vi.fn> }).cancelSubscription).not.toHaveBeenCalled()
  })

  it('logs and carries on when it cannot, unless the caller retries', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = provider({ cancelSubscription: vi.fn().mockRejectedValue(new Error('polar down')) })
    expect(await cancelCompanionSubscription(p, { companion_subscription_id: 'sub_c1' }, 'test')).toBe(false)
    await expect(cancelCompanionSubscription(p, { companion_subscription_id: 'sub_c1' }, 'revoke', true)).rejects.toThrow('polar down')
    log.mockRestore()
  })
})

describe('reconcileCompanionSubscriptions', () => {
  it('picks the active yearly accounts with no companion', () => {
    const rows = [
      yearlyRow(),
      yearlyRow({ workspace_id: 'ws-has', plugin_metadata: { companion_subscription_id: 'sub_c9' } }),
      yearlyRow({ workspace_id: 'ws-monthly', current_period_end: '2026-11-01T00:00:00Z' }),
      yearlyRow({ workspace_id: 'ws-trial', subscription_status: 'trialing' }),
      yearlyRow({ workspace_id: 'ws-nosub', subscription_id: null }),
    ] as never
    expect(accountsMissingCompanion(rows).map(r => r.workspace_id)).toEqual(['ws-1'])
  })

  it('opens the missing ones and records them; the provider reads the plan subscription\'s product itself', async () => {
    const db = { listActivePaymentAccounts: vi.fn().mockResolvedValue([yearlyRow()]), setPaymentAccountMetadataKey: vi.fn().mockResolvedValue(true) }
    const p = provider()
    expect(await reconcileCompanionSubscriptions(p, db, 'polar')).toEqual({ checked: 1, opened: 1, failed: 0 })
    expect((p as { ensureCompanionSubscription: ReturnType<typeof vi.fn> }).ensureCompanionSubscription).toHaveBeenCalledWith({
      workspaceId: 'ws-1', plan: 'pro', customerId: 'cus_1', parentSubscriptionId: 'sub_1',
    })
    expect(db.setPaymentAccountMetadataKey).toHaveBeenCalledWith(expect.objectContaining({ key: 'companion_subscription_id', value: 'sub_c1' }))
  })

  it('counts a failure and goes on with the rest', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = { listActivePaymentAccounts: vi.fn().mockResolvedValue([yearlyRow(), yearlyRow({ workspace_id: 'ws-2' })]), setPaymentAccountMetadataKey: vi.fn().mockResolvedValue(true) }
    const ensure = vi.fn().mockRejectedValueOnce(new Error('polar down')).mockResolvedValueOnce({ subscriptionId: 'sub_c2', created: true })
    expect(await reconcileCompanionSubscriptions(provider({ ensureCompanionSubscription: ensure }), db, 'polar')).toEqual({ checked: 2, opened: 1, failed: 1 })
    log.mockRestore()
  })

  it('is a no-op when companions are off (the provider answers null)', async () => {
    const db = { listActivePaymentAccounts: vi.fn().mockResolvedValue([yearlyRow()]), setPaymentAccountMetadataKey: vi.fn() }
    expect(await reconcileCompanionSubscriptions(provider({ ensureCompanionSubscription: vi.fn().mockResolvedValue(null) }), db, 'polar')).toEqual({ checked: 1, opened: 0, failed: 0 })
    expect(db.setPaymentAccountMetadataKey).not.toHaveBeenCalled()
  })
})
