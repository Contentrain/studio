/**
 * Billing enforcement middleware.
 *
 * Resolves workspace billing state on workspace-scoped API routes.
 * Attaches billing context to event.context.billing for downstream use.
 * Returns 402 for locked states (trial_expired, grace_expired, canceled_expired).
 *
 * Self-hosted bypass: if NUXT_STRIPE_SECRET_KEY is not set, treats all
 * workspaces as subscribed with starter-level access (core features only).
 */

import { BILLING_SELECT_FIELDS, getEffectivePlan, isBillingLocked, resolveBillingState } from '../utils/billing'

const WORKSPACE_ROUTE_PREFIX = '/api/workspaces/'

// Routes that must work even when billing is locked (so user can pay)
const BILLING_EXEMPT_SUFFIXES = [
  '/billing/',
]

export default defineEventHandler(async (event) => {
  const path = getRequestPath(event)

  // Only check workspace-scoped API routes
  if (!path.startsWith(WORKSPACE_ROUTE_PREFIX))
    return

  // Extract workspaceId from path: /api/workspaces/:workspaceId/...
  const segments = path.slice(WORKSPACE_ROUTE_PREFIX.length).split('/')
  const workspaceId = segments[0]
  if (!workspaceId || segments.length < 2)
    return

  // Always allow billing routes (so user can pay even when locked)
  if (BILLING_EXEMPT_SUFFIXES.some(s => path.includes(s)))
    return

  // Auth must be resolved first (by 01.auth middleware)
  if (!event.context.auth)
    return

  // Self-hosted bypass: no Stripe key = starter-level access.
  // Core features work (Git, projects, chat, media). Premium features
  // (preview branches, custom variants, spam filter) stay gated.
  // ee/ features still require the enterprise bridge to be loaded.
  const config = useRuntimeConfig()
  if (!config.stripe?.secretKey) {
    event.context.billing = { state: 'subscribed' as const, effectivePlan: 'starter' as const }
    return
  }

  const db = useDatabaseProvider()
  const workspace = await db.getWorkspaceById(workspaceId, BILLING_SELECT_FIELDS)

  if (!workspace)
    return

  const billingRow = workspace as {
    type: string
    plan: string | null
    trial_ends_at: string | null
    subscription_status: string | null
    stripe_subscription_id: string | null
    subscription_current_period_end: string | null
    grace_period_ends_at: string | null
    overage_settings?: Record<string, boolean> | null
  }

  const state = resolveBillingState(billingRow)
  const effectivePlan = getEffectivePlan(billingRow)

  // Attach billing context for downstream route handlers
  event.context.billing = { state, effectivePlan, overageSettings: billingRow.overage_settings ?? {} }

  // Block locked states
  if (isBillingLocked(state)) {
    throw createError({
      statusCode: 402,
      message: 'Payment required. Please subscribe to continue.',
      data: {
        billingState: state,
        workspaceId,
        requiresCheckout: true,
      },
    })
  }
})
