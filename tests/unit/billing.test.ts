import { describe, expect, it } from 'vitest'
import { getEffectivePlan, isBillingAccessible, isBillingLocked, resolveBillingState } from '../../server/utils/billing'
import type { WorkspaceBillingRow } from '../../server/utils/billing'

function makeWorkspace(overrides: Partial<WorkspaceBillingRow> = {}): WorkspaceBillingRow {
  return {
    type: 'secondary',
    plan: 'free',
    trial_ends_at: null,
    subscription_status: null,
    stripe_subscription_id: null,
    subscription_current_period_end: null,
    grace_period_ends_at: null,
    ...overrides,
  }
}

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
const PAST = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

describe('resolveBillingState', () => {
  it('returns "free" for primary workspace without subscription', () => {
    expect(resolveBillingState(makeWorkspace({ type: 'primary' }))).toBe('free')
  })

  it('returns "subscribed" for active Stripe subscription', () => {
    expect(resolveBillingState(makeWorkspace({
      subscription_status: 'active',
      stripe_subscription_id: 'sub_123',
      plan: 'pro',
    }))).toBe('subscribed')
  })

  it('returns "trial_active" for Stripe trialing status', () => {
    expect(resolveBillingState(makeWorkspace({
      subscription_status: 'trialing',
      stripe_subscription_id: 'sub_123',
      plan: 'starter',
      trial_ends_at: FUTURE,
    }))).toBe('trial_active')
  })

  it('returns "trial_expired" when Stripe trial ended', () => {
    expect(resolveBillingState(makeWorkspace({
      subscription_status: 'trialing',
      stripe_subscription_id: 'sub_123',
      plan: 'starter',
      trial_ends_at: PAST,
    }))).toBe('trial_expired')
  })

  it('returns "past_due" during grace period', () => {
    expect(resolveBillingState(makeWorkspace({
      subscription_status: 'past_due',
      stripe_subscription_id: 'sub_123',
      plan: 'pro',
      grace_period_ends_at: FUTURE,
    }))).toBe('past_due')
  })

  it('returns "grace_expired" after grace period ends', () => {
    expect(resolveBillingState(makeWorkspace({
      subscription_status: 'past_due',
      stripe_subscription_id: 'sub_123',
      plan: 'pro',
      grace_period_ends_at: PAST,
    }))).toBe('grace_expired')
  })

  it('returns "canceled" when subscription canceled but still in period', () => {
    expect(resolveBillingState(makeWorkspace({
      subscription_status: 'canceled',
      stripe_subscription_id: 'sub_123',
      plan: 'pro',
      subscription_current_period_end: FUTURE,
    }))).toBe('canceled')
  })

  it('returns "canceled_expired" when period ended after cancel', () => {
    expect(resolveBillingState(makeWorkspace({
      subscription_status: 'canceled',
      stripe_subscription_id: 'sub_123',
      plan: 'pro',
      subscription_current_period_end: PAST,
    }))).toBe('canceled_expired')
  })

  it('returns "free" for secondary workspace without any subscription or trial', () => {
    expect(resolveBillingState(makeWorkspace({ type: 'secondary' }))).toBe('free')
  })

  it('returns "grace_expired" for unpaid/incomplete status', () => {
    expect(resolveBillingState(makeWorkspace({ subscription_status: 'unpaid' }))).toBe('grace_expired')
    expect(resolveBillingState(makeWorkspace({ subscription_status: 'incomplete' }))).toBe('grace_expired')
  })
})

describe('isBillingAccessible / isBillingLocked', () => {
  it('accessible states', () => {
    expect(isBillingAccessible('free')).toBe(true)
    expect(isBillingAccessible('trial_active')).toBe(true)
    expect(isBillingAccessible('subscribed')).toBe(true)
    expect(isBillingAccessible('past_due')).toBe(true)
    expect(isBillingAccessible('canceled')).toBe(true)
  })

  it('locked states', () => {
    expect(isBillingLocked('trial_expired')).toBe(true)
    expect(isBillingLocked('grace_expired')).toBe(true)
    expect(isBillingLocked('canceled_expired')).toBe(true)
  })
})

describe('getEffectivePlan', () => {
  it('returns "free" for free primary workspace', () => {
    expect(getEffectivePlan(makeWorkspace({ type: 'primary' }))).toBe('free')
  })

  it('returns selected plan during trial', () => {
    expect(getEffectivePlan(makeWorkspace({
      subscription_status: 'trialing',
      stripe_subscription_id: 'sub_123',
      plan: 'pro',
      trial_ends_at: FUTURE,
    }))).toBe('pro')
  })

  it('returns plan for active subscription', () => {
    expect(getEffectivePlan(makeWorkspace({
      subscription_status: 'active',
      stripe_subscription_id: 'sub_123',
      plan: 'starter',
    }))).toBe('starter')
  })

  it('returns plan during grace period (past_due)', () => {
    expect(getEffectivePlan(makeWorkspace({
      subscription_status: 'past_due',
      plan: 'pro',
      grace_period_ends_at: FUTURE,
    }))).toBe('pro')
  })

  it('returns plan during canceled period', () => {
    expect(getEffectivePlan(makeWorkspace({
      subscription_status: 'canceled',
      stripe_subscription_id: 'sub_123',
      plan: 'pro',
      subscription_current_period_end: FUTURE,
    }))).toBe('pro')
  })

  it('returns "free" for locked states', () => {
    expect(getEffectivePlan(makeWorkspace({
      subscription_status: 'past_due',
      plan: 'pro',
      grace_period_ends_at: PAST,
    }))).toBe('free')

    expect(getEffectivePlan(makeWorkspace({
      subscription_status: 'canceled',
      stripe_subscription_id: 'sub_123',
      plan: 'pro',
      subscription_current_period_end: PAST,
    }))).toBe('free')
  })
})
