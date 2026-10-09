import { describe, expect, it } from 'vitest'
import { isYearlyPeriod, reconcileOverageLock, resolveOverageLocks, withoutLockedOverage } from '../../server/utils/overage-lock'

// What a Polar subscription created before the credit meters carries, and
// what one on current prices carries (`scripts/polar-sync.ts`).
const LEGACY_PRICES = ['ai_messages', 'api_messages', 'cdn_bandwidth_bytes', 'form_submissions', 'mcp_calls', 'media_storage_byte_hours']
const CURRENT_PRICES = ['ai_credits', 'api_credits', 'form_submissions', 'mcp_calls']

describe('resolveOverageLocks', () => {
  it('locks nothing without an account', () => {
    expect(resolveOverageLocks(null)).toEqual({})
  })

  it('locks every toggle during a trial, until the trial ends', () => {
    const locks = resolveOverageLocks({ subscription_status: 'trialing', trial_ends_at: '2026-09-29T07:36:51.653Z' })
    expect(locks.ai_messages).toEqual({ reason: 'trialing', until: '2026-09-29T07:36:51.653Z' })
    // Only priced overage has a toggle to lock; CDN and media are hard limits (no overage price).
    expect(Object.keys(locks).toSorted()).toEqual(['ai_messages', 'api_messages', 'form_submissions', 'mcp_calls'])
  })

  it('falls back to the period end when a trial has no recorded trial end', () => {
    const locks = resolveOverageLocks({ subscription_status: 'trialing', current_period_end: '2026-10-05T08:06:40.869Z' })
    expect(locks.ai_messages?.until).toBe('2026-10-05T08:06:40.869Z')
  })

  it('locks the meters an active subscription has no price for', () => {
    const locks = resolveOverageLocks({
      subscription_status: 'active',
      plugin_metadata: { billable_meters: LEGACY_PRICES },
    })
    // The credit meters are missing from a legacy subscription; the call
    // and submission meters are priced on it and stay sellable.
    expect(locks.ai_messages).toEqual({ reason: 'not_in_subscription', until: null })
    expect(locks.api_messages).toEqual({ reason: 'not_in_subscription', until: null })
    expect(locks.mcp_calls).toBeUndefined()
    expect(locks.form_submissions).toBeUndefined()
  })

  it('locks nothing on a subscription with current prices', () => {
    const locks = resolveOverageLocks({ subscription_status: 'active', plugin_metadata: { billable_meters: CURRENT_PRICES } })
    expect(locks.ai_messages).toBeUndefined()
    expect(locks.api_messages).toBeUndefined()
  })

  it('checks a v2 subscription against its own $0.01 credit meters', () => {
    const v2 = resolveOverageLocks({ subscription_status: 'active', plugin_metadata: { billable_meters: ['ai_credits_1c', 'api_credits_1c', 'mcp_calls'] } })
    expect(v2.ai_messages).toBeUndefined()
    expect(v2.api_messages).toBeUndefined()
    // A v2 product without the API credit price cannot sell API overage.
    const noApi = resolveOverageLocks({ subscription_status: 'active', plugin_metadata: { billable_meters: ['ai_credits_1c', 'mcp_calls'] } })
    expect(noApi.api_messages).toEqual({ reason: 'not_in_subscription', until: null })
  })

  it('names a yearly plan as the reason, not a subscription support can update', () => {
    // A yearly subscription (a Migrate bundle) prices no meter: Polar would bill its overage once a year.
    const locks = resolveOverageLocks({
      subscription_status: 'active',
      current_period_start: '2026-10-04T00:00:00.000Z',
      current_period_end: '2027-10-04T00:00:00.000Z',
      plugin_metadata: { billable_meters: [] },
    })
    expect(locks.ai_messages).toEqual({ reason: 'yearly_plan', until: null })
    // Only priced overage has a toggle to lock; CDN and media are hard limits (no overage price).
    expect(Object.keys(locks).toSorted()).toEqual(['ai_messages', 'api_messages', 'form_submissions', 'mcp_calls'])
  })

  it('keeps a monthly subscription with no price on the generic reason', () => {
    const locks = resolveOverageLocks({
      subscription_status: 'active',
      current_period_start: '2026-10-04T00:00:00.000Z',
      current_period_end: '2026-11-04T00:00:00.000Z',
      plugin_metadata: { billable_meters: LEGACY_PRICES },
    })
    expect(locks.ai_messages?.reason).toBe('not_in_subscription')
  })

  it('applies only the trial rule when the provider never reported prices', () => {
    expect(resolveOverageLocks({ subscription_status: 'active', plugin_metadata: {} })).toEqual({})
    expect(resolveOverageLocks({ subscription_status: 'past_due', plugin_metadata: null })).toEqual({})
  })
})

describe('withoutLockedOverage', () => {
  it('turns locked toggles off and leaves the rest as set', () => {
    const locks = resolveOverageLocks({ subscription_status: 'active', plugin_metadata: { billable_meters: LEGACY_PRICES } })
    expect(withoutLockedOverage({ ai_messages: true, mcp_calls: true, api_messages: false }, locks))
      .toEqual({ ai_messages: false, mcp_calls: true, api_messages: false })
  })
})

describe('reconcileOverageLock', () => {
  it('suspends a toggle the subscription cannot bill and remembers it', () => {
    const result = reconcileOverageLock({
      settings: { ai_messages: true, mcp_calls: true },
      pluginMetadata: {},
      billableMeters: LEGACY_PRICES,
      account: { subscription_status: 'active' },
    })
    expect(result.settings).toEqual({ ai_messages: false, mcp_calls: true })
    expect(result.pluginMetadata).toEqual({ billable_meters: LEGACY_PRICES, overage_suspended: ['ai_messages'] })
  })

  it('turns a suspended toggle back on when the lock lifts — nobody re-enables it', () => {
    const result = reconcileOverageLock({
      settings: { ai_messages: false, mcp_calls: true },
      pluginMetadata: { billable_meters: LEGACY_PRICES, overage_suspended: ['ai_messages'] },
      billableMeters: CURRENT_PRICES,
      account: { subscription_status: 'active' },
    })
    expect(result.settings).toEqual({ ai_messages: true, mcp_calls: true })
    expect(result.pluginMetadata).toEqual({ billable_meters: CURRENT_PRICES })
  })

  it('keeps a suspended toggle suspended while the lock holds', () => {
    const result = reconcileOverageLock({
      settings: { ai_messages: false },
      pluginMetadata: { billable_meters: LEGACY_PRICES, overage_suspended: ['ai_messages'] },
      account: { subscription_status: 'active' },
    })
    expect(result).toEqual({ settings: null, pluginMetadata: undefined })
  })

  it('never turns on a toggle the customer left off', () => {
    const result = reconcileOverageLock({
      settings: { ai_messages: false },
      pluginMetadata: { billable_meters: LEGACY_PRICES },
      billableMeters: CURRENT_PRICES,
      account: { subscription_status: 'active' },
    })
    expect(result.settings).toBeNull()
  })

  it('suspends during a trial and restores at trial end', () => {
    const during = reconcileOverageLock({
      settings: { ai_messages: true },
      pluginMetadata: {},
      billableMeters: CURRENT_PRICES,
      account: { subscription_status: 'trialing', trial_ends_at: '2026-09-29T07:36:51.653Z' },
    })
    expect(during.settings).toEqual({ ai_messages: false })

    const after = reconcileOverageLock({
      settings: during.settings,
      pluginMetadata: during.pluginMetadata,
      billableMeters: CURRENT_PRICES,
      account: { subscription_status: 'active' },
    })
    expect(after.settings).toEqual({ ai_messages: true })
    expect(after.pluginMetadata).toEqual({ billable_meters: CURRENT_PRICES })
  })

  it('keeps other plugin metadata', () => {
    const result = reconcileOverageLock({
      settings: {},
      pluginMetadata: { polar_note: 'x' },
      billableMeters: CURRENT_PRICES,
      account: { subscription_status: 'active' },
    })
    expect(result.pluginMetadata).toEqual({ polar_note: 'x', billable_meters: CURRENT_PRICES })
  })
})

describe('isYearlyPeriod', () => {
  it('is true past a month and false for a month or an unknown period', () => {
    expect(isYearlyPeriod({ current_period_start: '2026-10-04T00:00:00Z', current_period_end: '2027-10-04T00:00:00Z' })).toBe(true)
    expect(isYearlyPeriod({ current_period_start: '2026-01-31T00:00:00Z', current_period_end: '2026-03-03T00:00:00Z' })).toBe(false)
    expect(isYearlyPeriod({ current_period_start: null, current_period_end: '2027-10-04T00:00:00Z' })).toBe(false)
    expect(isYearlyPeriod({})).toBe(false)
  })
})

describe('companion usage subscription meters', () => {
  const yearly = { subscription_status: 'active', current_period_start: '2026-10-01T00:00:00Z', current_period_end: '2027-10-01T00:00:00Z' }

  it('a yearly plan that prices nothing is locked as yearly_plan', () => {
    expect(resolveOverageLocks({ ...yearly, plugin_metadata: { billable_meters: [] } }).ai_messages?.reason).toBe('yearly_plan')
  })

  it('the companion meters lift the lock on what they price', () => {
    const locks = resolveOverageLocks({ ...yearly, plugin_metadata: { billable_meters: [], companion_billable_meters: CURRENT_PRICES.join(',') } })
    expect(locks.ai_messages).toBeUndefined()
    expect(locks.api_messages).toBeUndefined()
    expect(locks.form_submissions).toBeUndefined()
  })

  it('a meter the companion does not price reads as not_in_subscription, not yearly_plan', () => {
    const locks = resolveOverageLocks({ ...yearly, plugin_metadata: { billable_meters: [], companion_billable_meters: 'ai_credits_1c,api_credits_1c' } })
    expect(locks.ai_messages).toBeUndefined()
    expect(locks.mcp_calls).toEqual({ reason: 'not_in_subscription', until: null })
  })

  it('a companion recorded without any own list still counts as a recorded price list', () => {
    expect(resolveOverageLocks({ ...yearly, plugin_metadata: { companion_billable_meters: 'ai_credits' } }).ai_messages).toBeUndefined()
  })

  it('no companion keeps a yearly subscription locked exactly as before', () => {
    const locks = resolveOverageLocks({ ...yearly, plugin_metadata: { billable_meters: [], companion_subscription_id: '', companion_billable_meters: '' } })
    expect(locks.ai_messages?.reason).toBe('yearly_plan')
  })

  it('the companion turning up gives suspended toggles back, a subscription event without it would not', () => {
    const result = reconcileOverageLock({
      settings: { ai_messages: false },
      pluginMetadata: { billable_meters: [], overage_suspended: ['ai_messages'], companion_billable_meters: 'ai_credits,api_credits,form_submissions,mcp_calls' },
      account: yearly,
    })
    expect(result.settings).toEqual({ ai_messages: true })
  })
})
