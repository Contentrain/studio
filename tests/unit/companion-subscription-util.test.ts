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
  companionUsageEnabled: () => true,
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

/** An account row with the same conditional single-key write the real adapters make. */
function fakeDb(metadata: Record<string, unknown> = {}) {
  const row = { plugin_metadata: { ...metadata } as Record<string, unknown> }
  return {
    row,
    getActivePaymentAccount: vi.fn(async () => ({ workspace_id: 'ws-1', plugin_metadata: { ...row.plugin_metadata } })),
    setPaymentAccountMetadataKey: vi.fn(async ({ key, value, when }: { key: string, value: string, when: 'absent' | 'different' | { equals: string } }) => {
      const current = row.plugin_metadata[key]
      const allowed = when === 'absent' ? !(key in row.plugin_metadata) : when === 'different' ? current !== value : current === when.equals
      if (!allowed) return false
      row.plugin_metadata[key] = value
      return true
    }),
  }
}

describe('openCompanionSubscription', () => {
  const args = { workspaceId: 'ws-1', plan: 'pro', customerId: 'cus_1', subscriptionId: 'sub_1', productId: 'prod_pro_y' }
  const ensureOf = (p: unknown) => (p as { ensureCompanionSubscription: ReturnType<typeof vi.fn> }).ensureCompanionSubscription

  it('claims the workspace, records the companion and settles the claim for this product', async () => {
    const db = fakeDb()
    const p = provider()
    expect(await openCompanionSubscription(p, db, args)).toBe('opened')
    expect(ensureOf(p)).toHaveBeenCalledWith({
      workspaceId: 'ws-1', plan: 'pro', customerId: 'cus_1', parentSubscriptionId: 'sub_1', parentProductId: 'prod_pro_y',
    })
    expect(db.row.plugin_metadata.companion_subscription_id).toBe('sub_c1')
    expect(db.row.plugin_metadata.companion_claim).toBe('done:prod_pro_y')
  })

  it('opens exactly one companion when several callers race (created, updated, reconciler)', async () => {
    const db = fakeDb()
    const ensure = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 5))
      return { subscriptionId: 'sub_c1', created: true }
    })
    const p = provider({ ensureCompanionSubscription: ensure })
    const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => openCompanionSubscription(p, db, args)))
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(outcomes.filter(o => o === 'opened')).toHaveLength(1)
    expect(outcomes.filter(o => o === 'busy')).toHaveLength(4)
  })

  it('does not open again once settled for the same product', async () => {
    const db = fakeDb({ companion_claim: 'done:prod_pro_y', companion_subscription_id: 'sub_c1' })
    const p = provider()
    expect(await openCompanionSubscription(p, db, args)).toBe('busy')
    expect(ensureOf(p)).not.toHaveBeenCalled()
  })

  it('takes over a claim whose holder died, but not a fresh one', async () => {
    const stale = fakeDb({ companion_claim: `opening:${Date.now() - 11 * 60 * 1000}` })
    expect(await openCompanionSubscription(provider(), stale, args)).toBe('opened')
    const fresh = fakeDb({ companion_claim: `opening:${Date.now() - 1000}` })
    expect(await openCompanionSubscription(provider(), fresh, args)).toBe('busy')
  })

  it('replaces the companion when the plan moved to another product: old one cancelled first, then a new one', async () => {
    const db = fakeDb({ companion_claim: 'done:prod_starter_y', companion_subscription_id: 'sub_old', companion_billable_meters: 'a,b' })
    const p = provider()
    expect(await openCompanionSubscription(p, db, args)).toBe('opened')
    expect((p as { cancelSubscription: ReturnType<typeof vi.fn> }).cancelSubscription).toHaveBeenCalledWith('sub_old')
    expect(db.row.plugin_metadata.companion_subscription_id).toBe('sub_c1')
    expect(db.row.plugin_metadata.companion_claim).toBe('done:prod_pro_y')
  })

  it('a claim the reconciler stamped without a product is learned, not mistaken for a product change', async () => {
    const db = fakeDb({ companion_claim: 'done:', companion_subscription_id: 'sub_c1' })
    const p = provider()
    expect(await openCompanionSubscription(p, db, args)).toBe('busy')
    expect((p as { cancelSubscription: ReturnType<typeof vi.fn> }).cancelSubscription).not.toHaveBeenCalled()
    expect(ensureOf(p)).not.toHaveBeenCalled()
    expect(db.row.plugin_metadata.companion_claim).toBe('done:prod_pro_y')
    expect(db.row.plugin_metadata.companion_subscription_id).toBe('sub_c1')
    // Stamped now, so a real change is still a change.
    expect(await openCompanionSubscription(p, db, { ...args, productId: 'prod_starter_y' })).toBe('opened')
  })

  it('a product switch whose old companion will not cancel throws and leaves the claim as it was, so the webhook retries', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = fakeDb({ companion_claim: 'done:prod_starter_y', companion_subscription_id: 'sub_old' })
    const p = provider({ cancelSubscription: vi.fn().mockRejectedValue(new Error('polar down')) })
    await expect(openCompanionSubscription(p, db, args)).rejects.toThrow('polar down')
    expect(db.row.plugin_metadata.companion_claim).toBe('done:prod_starter_y')
    expect(db.row.plugin_metadata.companion_subscription_id).toBe('sub_old')
    expect(ensureOf(p)).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('does nothing, and writes nothing, when companions are off or the provider has none', async () => {
    const db = fakeDb()
    expect(await openCompanionSubscription(provider({ companionUsageEnabled: () => false }), db, args)).toBe('skipped')
    expect(await openCompanionSubscription(provider({ ensureCompanionSubscription: undefined }), db, args)).toBe('skipped')
    expect(await openCompanionSubscription(provider(), db, { ...args, plan: 'free' })).toBe('skipped')
    expect(db.setPaymentAccountMetadataKey).not.toHaveBeenCalled()
  })

  it('remembers that this product gets no companion (monthly plan) instead of asking again', async () => {
    const db = fakeDb()
    const p = provider({ ensureCompanionSubscription: vi.fn().mockResolvedValue(null) })
    expect(await openCompanionSubscription(p, db, args)).toBe('skipped')
    expect(db.row.plugin_metadata.companion_claim).toBe('skipped:prod_pro_y')
    expect(await openCompanionSubscription(p, db, args)).toBe('busy')
  })

  it('never throws on a provider failure: an ALARM in the log, the claim is released for the reconciler', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = fakeDb()
    const p = provider({ ensureCompanionSubscription: vi.fn().mockRejectedValueOnce(new Error('polar down')).mockResolvedValue({ subscriptionId: 'sub_c1', created: true }) })
    expect(await openCompanionSubscription(p, db, args)).toBe('failed')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[companion] ALARM'), expect.any(Error))
    expect(db.row.plugin_metadata.companion_claim).toBe('failed')
    expect(await openCompanionSubscription(p, db, args)).toBe('opened')
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
      yearlyRow({ workspace_id: 'ws-settled', plugin_metadata: { companion_claim: 'skipped:prod_pro_m' } }),
    ] as never
    expect(accountsMissingCompanion(rows).map(r => r.workspace_id)).toEqual(['ws-1'])
  })

  it('opens the missing ones through the same claim; the provider reads the plan subscription\'s product itself', async () => {
    const db = { ...fakeDb(), listActivePaymentAccounts: vi.fn().mockResolvedValue([yearlyRow()]) }
    const p = provider()
    expect(await reconcileCompanionSubscriptions(p, db, 'polar')).toEqual({ checked: 1, opened: 1, failed: 0 })
    expect((p as { ensureCompanionSubscription: ReturnType<typeof vi.fn> }).ensureCompanionSubscription).toHaveBeenCalledWith({
      workspaceId: 'ws-1', plan: 'pro', customerId: 'cus_1', parentSubscriptionId: 'sub_1',
    })
    expect(db.row.plugin_metadata.companion_subscription_id).toBe('sub_c1')
  })

  it('counts a failure and goes on with the rest', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = { ...fakeDb(), listActivePaymentAccounts: vi.fn().mockResolvedValue([yearlyRow(), yearlyRow({ workspace_id: 'ws-2' })]) }
    const ensure = vi.fn().mockRejectedValueOnce(new Error('polar down')).mockResolvedValueOnce({ subscriptionId: 'sub_c2', created: true })
    expect(await reconcileCompanionSubscriptions(provider({ ensureCompanionSubscription: ensure }), db, 'polar')).toEqual({ checked: 2, opened: 1, failed: 1 })
    log.mockRestore()
  })

  it('is a no-op that does not even list accounts when companions are off', async () => {
    const db = { ...fakeDb(), listActivePaymentAccounts: vi.fn().mockResolvedValue([yearlyRow()]) }
    expect(await reconcileCompanionSubscriptions(provider({ companionUsageEnabled: () => false }), db, 'polar')).toEqual({ checked: 0, opened: 0, failed: 0 })
    expect(db.listActivePaymentAccounts).not.toHaveBeenCalled()
  })
})
