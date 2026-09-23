import { describe, expect, it } from 'vitest'
import { reconcileOverageLock, resolveOverageLocks, withoutLockedOverage } from '../../server/utils/overage-lock'

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
    expect(Object.keys(locks).toSorted()).toEqual(['ai_messages', 'api_messages', 'cdn_bandwidth', 'form_submissions', 'mcp_calls', 'media_storage'])
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
