/**
 * Billing state machine.
 *
 * Resolves workspace billing state from DB columns and determines
 * the effective plan for limit enforcement.
 *
 * State transitions are driven by Stripe webhooks — never by app code.
 * The only exception is self-hosted mode (no Stripe key) which bypasses billing.
 */

import type { StudioPlan } from '../../shared/utils/license'
import { normalizePlan } from '../../shared/utils/license'

export type BillingState
  = 'free' // Primary workspace, free tier — no subscription needed
    | 'trial_active' // Stripe trial period running (subscription_status='trialing')
    | 'trial_expired' // Trial ended without payment — workspace locked
    | 'subscribed' // Active paid subscription (subscription_status='active')
    | 'past_due' // Payment failed, in grace period — still accessible
    | 'grace_expired' // Grace period ended — workspace locked
    | 'canceled' // Subscription canceled, still within paid period
    | 'canceled_expired' // Paid period ended after cancel — workspace locked

export interface WorkspaceBillingRow {
  type: string
  plan: string | null
  trial_ends_at: string | null
  subscription_status: string | null
  stripe_subscription_id: string | null
  subscription_current_period_end: string | null
  grace_period_ends_at: string | null
}

/** Columns needed for billing state resolution. */
export const BILLING_SELECT_FIELDS = 'type, plan, trial_ends_at, subscription_status, stripe_subscription_id, subscription_current_period_end, grace_period_ends_at'

/**
 * Resolve the billing state of a workspace.
 *
 * Priority: subscription_status (Stripe source of truth) > trial_ends_at > workspace type.
 */
export function resolveBillingState(workspace: WorkspaceBillingRow): BillingState {
  const { subscription_status, type, trial_ends_at, stripe_subscription_id } = workspace
  const now = Date.now()

  // 1. Active Stripe subscription
  if (subscription_status === 'active' && stripe_subscription_id) {
    return 'subscribed'
  }

  // 2. Stripe trial (subscription exists with trialing status)
  if (subscription_status === 'trialing' && stripe_subscription_id) {
    // Double-check trial_ends_at if available
    if (trial_ends_at && new Date(trial_ends_at).getTime() <= now) {
      return 'trial_expired'
    }
    return 'trial_active'
  }

  // 3. Payment failed — check grace period
  if (subscription_status === 'past_due') {
    const graceEnd = workspace.grace_period_ends_at
    if (graceEnd && new Date(graceEnd).getTime() <= now) {
      return 'grace_expired'
    }
    return 'past_due'
  }

  // 4. Subscription canceled — check if still within paid period
  if (subscription_status === 'canceled') {
    const periodEnd = workspace.subscription_current_period_end
    if (periodEnd && new Date(periodEnd).getTime() > now) {
      return 'canceled'
    }
    return 'canceled_expired'
  }

  // 5. Other Stripe statuses (unpaid, incomplete) — treat as locked
  if (subscription_status === 'unpaid' || subscription_status === 'incomplete') {
    return 'grace_expired'
  }

  // 6. No subscription — check workspace type
  if (type === 'primary') {
    return 'free'
  }

  // 7. Secondary workspace without subscription — check old trial_ends_at
  if (trial_ends_at) {
    if (new Date(trial_ends_at).getTime() > now) {
      return 'trial_active'
    }
    return 'trial_expired'
  }

  // 8. Secondary workspace, no trial, no subscription — treat as free
  return 'free'
}

/**
 * States that allow full workspace access.
 */
const ACCESSIBLE_STATES: ReadonlySet<BillingState> = new Set([
  'free',
  'trial_active',
  'subscribed',
  'past_due',
  'canceled',
])

/**
 * States that require payment (402 response).
 */
const LOCKED_STATES: ReadonlySet<BillingState> = new Set([
  'trial_expired',
  'grace_expired',
  'canceled_expired',
])

export function isBillingAccessible(state: BillingState): boolean {
  return ACCESSIBLE_STATES.has(state)
}

export function isBillingLocked(state: BillingState): boolean {
  return LOCKED_STATES.has(state)
}

/**
 * Get the effective plan for limit enforcement.
 *
 * During trial: uses the plan from the Stripe subscription (what user selected at checkout).
 * Free: returns 'free' (severe limits, no Git/projects).
 * Locked states: returns 'free' (fallback — routes should 402 before reaching limits).
 */
export function getEffectivePlan(workspace: WorkspaceBillingRow): StudioPlan {
  const state = resolveBillingState(workspace)

  switch (state) {
    case 'free':
      return 'free'
    case 'trial_active':
    case 'subscribed':
    case 'past_due':
    case 'canceled':
      return normalizePlan(workspace.plan)
    case 'trial_expired':
    case 'grace_expired':
    case 'canceled_expired':
      return 'free'
  }
}
