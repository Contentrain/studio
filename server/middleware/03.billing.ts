/**
 * Billing enforcement middleware.
 *
 * Resolves workspace billing state on workspace-scoped API routes.
 * Attaches billing context to event.context.billing for downstream use.
 * Returns 402 for locked states (trial_expired, grace_expired, canceled_expired).
 *
 * Self-hosted bypass: if no payment provider is configured, treats all
 * workspaces as subscribed with starter-level access (core features only).
 */

import { getEffectivePlan, isBillingLocked, resolveBillingState, WORKSPACE_BILLING_SELECT_FIELDS } from '../utils/billing'
import type { PaymentAccountState, WorkspaceBillingRow } from '../utils/billing'
import { isBillingConfigured } from '../utils/license'

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

  // Self-hosted bypass: no payment provider = starter-level access.
  // Core features work (Git, projects, chat, media). Premium features
  // (preview branches, custom variants, spam filter) stay gated.
  // ee/ features still require the enterprise bridge to be loaded.
  if (!isBillingConfigured()) {
    event.context.billing = { state: 'subscribed' as const, effectivePlan: 'starter' as const }
    return
  }

  const db = useDatabaseProvider()
  const [workspace, account] = await Promise.all([
    db.getWorkspaceById(workspaceId, WORKSPACE_BILLING_SELECT_FIELDS),
    db.getActivePaymentAccount(workspaceId),
  ])

  if (!workspace)
    return

  const billingRow: WorkspaceBillingRow = {
    type: workspace.type as string,
    plan: (workspace.plan as string | null) ?? null,
    payment_account: (account as unknown as PaymentAccountState | null) ?? null,
    overage_settings: (workspace.overage_settings as Record<string, boolean> | null | undefined) ?? undefined,
  }

  const state = resolveBillingState(billingRow)
  const effectivePlan = getEffectivePlan(billingRow)

  event.context.billing = { state, effectivePlan, overageSettings: billingRow.overage_settings ?? {} }

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
