/**
 * Billing state machine.
 *
 * Resolves workspace billing state from the embedded `payment_account`
 * (the single active row from `payment_accounts`) and determines the
 * effective plan for limit enforcement.
 *
 * State transitions are driven by provider webhooks — never by app
 * code. Self-hosted deployments (no payment plugin configured) bypass
 * the state machine via the middleware fast-path.
 */

import type { StudioPlan } from '../../shared/utils/license'
import { normalizePlan } from '../../shared/utils/license'

export type BillingState
  = 'free' // Primary / free-tier workspace — no subscription needed
    | 'trial_active' // Active provider trial (subscription_status='trialing')
    | 'trial_expired' // Trial ended without payment — workspace locked
    | 'subscribed' // Active paid subscription (subscription_status='active')
    | 'past_due' // Payment failed, in grace period — still accessible
    | 'grace_expired' // Grace period ended — workspace locked
    | 'canceled' // Subscription canceled, still within paid period
    | 'canceled_expired' // Paid period ended after cancel — workspace locked

/** Active payment account fields required by the state machine. */
export interface PaymentAccountState {
  subscription_id: string | null
  subscription_status: string | null
  current_period_end: string | null
  trial_ends_at: string | null
  grace_period_ends_at: string | null
  cancel_at_period_end?: boolean | null
}

export interface WorkspaceBillingRow {
  type: string
  plan: string | null
  /** Active payment account — null when workspace has no subscription. */
  payment_account: PaymentAccountState | null
  overage_settings?: Record<string, boolean> | null
}

/** Columns needed for billing state resolution (workspaces table only). */
export const WORKSPACE_BILLING_SELECT_FIELDS = 'type, plan, overage_settings'

/**
 * Resolve the billing state of a workspace.
 *
 * Priority: payment_account.subscription_status (provider source of
 * truth) > workspace type. Any legacy pre-plugin `trial_ends_at` on the
 * workspace row is gone after migration 003.
 */
export function resolveBillingState(workspace: WorkspaceBillingRow): BillingState {
  const account = workspace.payment_account
  const now = Date.now()

  if (account) {
    const { subscription_status, subscription_id, trial_ends_at, grace_period_ends_at, current_period_end } = account

    if (subscription_status === 'active' && subscription_id) {
      return 'subscribed'
    }

    if (subscription_status === 'trialing' && subscription_id) {
      if (trial_ends_at && new Date(trial_ends_at).getTime() <= now) {
        return 'trial_expired'
      }
      return 'trial_active'
    }

    if (subscription_status === 'past_due') {
      if (grace_period_ends_at && new Date(grace_period_ends_at).getTime() <= now) {
        return 'grace_expired'
      }
      return 'past_due'
    }

    if (subscription_status === 'canceled') {
      if (current_period_end && new Date(current_period_end).getTime() > now) {
        return 'canceled'
      }
      return 'canceled_expired'
    }

    if (subscription_status === 'unpaid' || subscription_status === 'incomplete') {
      return 'grace_expired'
    }
  }

  // No active payment account — check workspace type
  if (workspace.type === 'primary') {
    return 'free'
  }

  // Secondary workspace without subscription — treat as free shell
  return 'free'
}

/** States that allow full workspace access. */
const ACCESSIBLE_STATES: ReadonlySet<BillingState> = new Set([
  'free',
  'trial_active',
  'subscribed',
  'past_due',
  'canceled',
])

/** States that require payment (402 response). */
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
 * During trial: uses the plan from the payment account (what the user
 * selected at checkout).
 * Free: returns 'free' (severe limits, no Git/projects).
 * Locked states: returns 'free' (fallback — routes should 402 before
 * reaching limits).
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
