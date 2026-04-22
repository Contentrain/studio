import { describe, expect, it } from 'vitest'
import { getEffectivePlan, isBillingAccessible, isBillingLocked, resolveBillingState } from '../../server/utils/billing'
import type { PaymentAccountState, WorkspaceBillingRow } from '../../server/utils/billing'

function makeAccount(overrides: Partial<PaymentAccountState> = {}): PaymentAccountState {
  return {
    subscription_id: null,
    subscription_status: null,
    current_period_end: null,
    trial_ends_at: null,
    grace_period_ends_at: null,
    cancel_at_period_end: false,
    ...overrides,
  }
}

function makeWorkspace(overrides: Partial<WorkspaceBillingRow> = {}): WorkspaceBillingRow {
  return {
    type: 'secondary',
    plan: 'free',
    payment_account: null,
    ...overrides,
  }
}

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
const PAST = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

describe('resolveBillingState', () => {
  it('returns "free" for primary workspace without subscription', () => {
    expect(resolveBillingState(makeWorkspace({ type: 'primary' }))).toBe('free')
  })

  it('returns "subscribed" for active subscription', () => {
    expect(resolveBillingState(makeWorkspace({
      payment_account: makeAccount({
        subscription_status: 'active',
        subscription_id: 'sub_123',
      }),
      plan: 'pro',
    }))).toBe('subscribed')
  })

  it('returns "trial_active" for trialing status', () => {
    expect(resolveBillingState(makeWorkspace({
      payment_account: makeAccount({
        subscription_status: 'trialing',
        subscription_id: 'sub_123',
        trial_ends_at: FUTURE,
      }),
      plan: 'starter',
    }))).toBe('trial_active')
  })

  it('returns "trial_expired" when trial ended', () => {
    expect(resolveBillingState(makeWorkspace({
      payment_account: makeAccount({
        subscription_status: 'trialing',
        subscription_id: 'sub_123',
        trial_ends_at: PAST,
      }),
      plan: 'starter',
    }))).toBe('trial_expired')
  })

  it('returns "past_due" during grace period', () => {
    expect(resolveBillingState(makeWorkspace({
      payment_account: makeAccount({
        subscription_status: 'past_due',
        subscription_id: 'sub_123',
        grace_period_ends_at: FUTURE,
      }),
      plan: 'pro',
    }))).toBe('past_due')
  })

  it('returns "grace_expired" after grace period ends', () => {
    expect(resolveBillingState(makeWorkspace({
      payment_account: makeAccount({
        subscription_status: 'past_due',
        subscription_id: 'sub_123',
        grace_period_ends_at: PAST,
      }),
      plan: 'pro',
    }))).toBe('grace_expired')
  })

  it('returns "canceled" when subscription canceled but still in period', () => {
    expect(resolveBillingState(makeWorkspace({
      payment_account: makeAccount({
        subscription_status: 'canceled',
        subscription_id: 'sub_123',
        current_period_end: FUTURE,
      }),
      plan: 'pro',
    }))).toBe('canceled')
  })

  it('returns "canceled_expired" when period ended after cancel', () => {
    expect(resolveBillingState(makeWorkspace({
      payment_account: makeAccount({
        subscription_status: 'canceled',
        subscription_id: 'sub_123',
        current_period_end: PAST,
      }),
      plan: 'pro',
    }))).toBe('canceled_expired')
  })

  it('returns "free" for secondary workspace without any subscription or trial', () => {
    expect(resolveBillingState(makeWorkspace({ type: 'secondary' }))).toBe('free')
  })

  it('returns "grace_expired" for unpaid/incomplete status', () => {
    expect(resolveBillingState(makeWorkspace({
      payment_account: makeAccount({ subscription_status: 'unpaid' }),
    }))).toBe('grace_expired')
    expect(resolveBillingState(makeWorkspace({
      payment_account: makeAccount({ subscription_status: 'incomplete' }),
    }))).toBe('grace_expired')
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
      payment_account: makeAccount({
        subscription_status: 'trialing',
        subscription_id: 'sub_123',
        trial_ends_at: FUTURE,
      }),
      plan: 'pro',
    }))).toBe('pro')
  })

  it('returns plan for active subscription', () => {
    expect(getEffectivePlan(makeWorkspace({
      payment_account: makeAccount({
        subscription_status: 'active',
        subscription_id: 'sub_123',
      }),
      plan: 'starter',
    }))).toBe('starter')
  })

  it('returns plan during grace period (past_due)', () => {
    expect(getEffectivePlan(makeWorkspace({
      payment_account: makeAccount({
        subscription_status: 'past_due',
        subscription_id: 'sub_123',
        grace_period_ends_at: FUTURE,
      }),
      plan: 'pro',
    }))).toBe('pro')
  })

  it('returns plan during canceled period', () => {
    expect(getEffectivePlan(makeWorkspace({
      payment_account: makeAccount({
        subscription_status: 'canceled',
        subscription_id: 'sub_123',
        current_period_end: FUTURE,
      }),
      plan: 'pro',
    }))).toBe('pro')
  })

  it('returns "free" for locked states', () => {
    expect(getEffectivePlan(makeWorkspace({
      payment_account: makeAccount({
        subscription_status: 'past_due',
        subscription_id: 'sub_123',
        grace_period_ends_at: PAST,
      }),
      plan: 'pro',
    }))).toBe('free')

    expect(getEffectivePlan(makeWorkspace({
      payment_account: makeAccount({
        subscription_status: 'canceled',
        subscription_id: 'sub_123',
        current_period_end: PAST,
      }),
      plan: 'pro',
    }))).toBe('free')
  })
})
