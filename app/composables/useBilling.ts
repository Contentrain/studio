/**
 * Client-side billing state composable.
 *
 * Resolves billing state from the embedded `payment_account` on the
 * active workspace. Mirrors server-side logic in `server/utils/billing.ts`.
 *
 * Client-side state is UX-only — authoritative enforcement is on the server.
 */

import type { StudioPlan } from '../../shared/utils/license'
import { normalizePlan } from '../../shared/utils/license'
import type { Workspace, WorkspacePaymentAccount } from './useWorkspaces'

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
  const account = ws.payment_account ?? null
  const now = Date.now()

  if (account) {
    const { subscription_status, subscription_id, trial_ends_at, grace_period_ends_at, current_period_end } = account

    if (subscription_status === 'active' && subscription_id) return 'subscribed'

    if (subscription_status === 'trialing' && subscription_id) {
      if (trial_ends_at && new Date(trial_ends_at).getTime() <= now) return 'trial_expired'
      return 'trial_active'
    }

    if (subscription_status === 'past_due') {
      if (grace_period_ends_at && new Date(grace_period_ends_at).getTime() <= now) return 'grace_expired'
      return 'past_due'
    }

    if (subscription_status === 'canceled') {
      if (current_period_end && new Date(current_period_end).getTime() > now) return 'canceled'
      return 'canceled_expired'
    }

    if (subscription_status === 'unpaid' || subscription_status === 'incomplete') return 'grace_expired'
  }

  if (ws.type === 'primary') return 'free'
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

  const activeAccount = computed<WorkspacePaymentAccount | null>(
    () => activeWorkspace.value?.payment_account ?? null,
  )

  const billingState = computed(() => {
    // Self-host bypass: no billing = starter-level access (mirrors server middleware)
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
    const account = activeAccount.value
    if (billingState.value !== 'trial_active' || !account?.trial_ends_at) return 0
    const diff = new Date(account.trial_ends_at).getTime() - Date.now()
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)))
  })

  /**
   * Start checkout for a plan via the active payment provider. Redirects to the
   * provider's hosted checkout page.
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
   * Open the active provider's customer portal for subscription management.
   */
  async function openPortal() {
    const ws = activeWorkspace.value
    if (!ws?.payment_account?.customer_id) return

    const { url } = await $fetch<{ url: string }>('/api/billing/portal', {
      method: 'POST',
      body: { workspaceId: ws.id },
    })

    if (url) {
      window.location.href = url
    }
  }

  /**
   * Refresh workspace data after billing changes (e.g., returning from checkout).
   */
  async function refreshBilling() {
    await fetchWorkspaces()
  }

  return {
    billingEnabled,
    billingState,
    effectivePlan,
    isLocked,
    requiresPayment,
    isFree,
    isTrialing,
    trialDaysLeft,
    activeAccount,
    startCheckout,
    openPortal,
    refreshBilling,
  }
}
