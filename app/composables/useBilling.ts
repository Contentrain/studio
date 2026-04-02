/**
 * Client-side billing state composable.
 *
 * Resolves billing state from the active workspace's DB columns.
 * Mirrors server-side logic in server/utils/billing.ts.
 *
 * Note: Client-side state is UX-only — authoritative enforcement is on the server.
 */

import type { StudioPlan } from '../../shared/utils/license'
import { normalizePlan } from '../../shared/utils/license'
import type { Workspace } from './useWorkspaces'

export type BillingState
  = | 'free'
    | 'trial_active'
    | 'trial_expired'
    | 'subscribed'
    | 'past_due'
    | 'grace_expired'
    | 'canceled'
    | 'canceled_expired'

function resolveState(ws: Workspace | null): BillingState {
  if (!ws) return 'free'

  const now = Date.now()
  const { subscription_status, type, trial_ends_at, stripe_subscription_id } = ws

  if (subscription_status === 'active' && stripe_subscription_id) return 'subscribed'

  if (subscription_status === 'trialing' && stripe_subscription_id) {
    if (trial_ends_at && new Date(trial_ends_at).getTime() <= now) return 'trial_expired'
    return 'trial_active'
  }

  if (subscription_status === 'past_due') {
    if (ws.grace_period_ends_at && new Date(ws.grace_period_ends_at).getTime() <= now) return 'grace_expired'
    return 'past_due'
  }

  if (subscription_status === 'canceled') {
    if (ws.subscription_current_period_end && new Date(ws.subscription_current_period_end).getTime() > now) return 'canceled'
    return 'canceled_expired'
  }

  if (subscription_status === 'unpaid' || subscription_status === 'incomplete') return 'grace_expired'

  if (type === 'primary') return 'free'

  if (trial_ends_at) {
    return new Date(trial_ends_at).getTime() > now ? 'trial_active' : 'trial_expired'
  }

  return 'free'
}

function resolveEffectivePlan(ws: Workspace | null, state: BillingState): StudioPlan {
  switch (state) {
    case 'trial_active':
    case 'subscribed':
    case 'past_due':
    case 'canceled':
      return normalizePlan(ws?.plan)
    default:
      return 'free'
  }
}

export function useBilling() {
  const { activeWorkspace, fetchWorkspaces } = useWorkspaces()
  const config = useRuntimeConfig()
  const billingEnabled = computed(() => config.public.billingEnabled === 'true')

  const billingState = computed(() => {
    // Self-host bypass: no Stripe = starter-level access (mirrors server middleware)
    if (!billingEnabled.value) return 'subscribed' as BillingState
    return resolveState(activeWorkspace.value)
  })

  const effectivePlan = computed(() => {
    if (!billingEnabled.value) {
      // Self-host: workspace.plan from DB, default to starter (not free)
      const dbPlan = normalizePlan(activeWorkspace.value?.plan)
      return (dbPlan === 'free' ? 'starter' : dbPlan) as StudioPlan
    }
    return resolveEffectivePlan(activeWorkspace.value, billingState.value)
  })

  const isLocked = computed(() =>
    ['trial_expired', 'grace_expired', 'canceled_expired'].includes(billingState.value),
  )

  const requiresPayment = computed(() =>
    ['trial_expired', 'past_due', 'grace_expired', 'canceled_expired'].includes(billingState.value),
  )

  const isFree = computed(() => billingState.value === 'free')

  const isTrialing = computed(() => billingState.value === 'trial_active')

  const trialDaysLeft = computed(() => {
    const ws = activeWorkspace.value
    if (billingState.value !== 'trial_active' || !ws?.trial_ends_at) return 0
    const diff = new Date(ws.trial_ends_at).getTime() - Date.now()
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)))
  })

  /**
   * Start Stripe Checkout for a plan. Redirects to Stripe hosted page.
   */
  async function startCheckout(plan: 'starter' | 'pro') {
    const ws = activeWorkspace.value
    if (!ws) return

    const { url } = await $fetch<{ url: string }>('/api/billing/checkout', {
      method: 'POST',
      body: { workspaceId: ws.id, plan },
    })

    if (url) {
      window.location.href = url
    }
  }

  /**
   * Open Stripe Customer Portal for subscription management.
   */
  async function openPortal() {
    const ws = activeWorkspace.value
    if (!ws?.stripe_customer_id) return

    const { url } = await $fetch<{ url: string }>('/api/billing/portal', {
      method: 'POST',
      body: { workspaceId: ws.id },
    })

    if (url) {
      window.location.href = url
    }
  }

  /**
   * Refresh workspace data after billing changes (e.g., returning from Stripe).
   */
  async function refreshBilling() {
    await fetchWorkspaces()
  }

  return {
    billingState,
    effectivePlan,
    isLocked,
    requiresPayment,
    isFree,
    isTrialing,
    trialDaysLeft,
    startCheckout,
    openPortal,
    refreshBilling,
  }
}
