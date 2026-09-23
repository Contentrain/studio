/**
 * The plan and overage a workspace is actually allowed, for routes the
 * billing middleware does not run on.
 *
 * `server/middleware/03.billing.ts` resolves this for `/api/workspaces/*`
 * and puts it on `event.context.billing`. The public, key-authenticated
 * surfaces — Conversation API, MCP Cloud (API key and OAuth) — sit outside
 * that prefix, and used to read `workspaces.plan` and
 * `workspaces.overage_settings` raw. So an expired trial or grace period
 * kept Pro limits there, and a toggle the subscription cannot bill still
 * raised the cap. This is the same resolution, callable from a route.
 */

import { createError } from 'h3'
import { getEffectivePlan, isBillingLocked, resolveBillingState } from './billing'
import type { BillingState, PaymentAccountState, WorkspaceBillingRow } from './billing'
import { getWorkspacePlan } from './license'
import { resolveDeployment } from './deployment'
import { resolveOverageLocks, withoutLockedOverage } from './overage-lock'
import type { OverageLockAccount } from './overage-lock'
import type { StudioPlan } from '../../shared/utils/license'

/** Workspace columns `resolveWorkspaceBilling` reads. Select them with the rest. */
export const WORKSPACE_BILLING_COLUMNS = ['type', 'plan', 'overage_settings'] as const

export interface WorkspaceBilling {
  state: BillingState
  /** The plan limits and features are enforced against. */
  effectivePlan: StudioPlan
  /** `overage_settings` with every toggle the subscription cannot bill turned off. */
  overageSettings: Record<string, boolean>
}

/**
 * `requireAccess`: refuse a workspace whose billing is locked (trial ended
 * unpaid, grace period over, cancellation took effect) with 402 — the same
 * status and `data` shape as the billing middleware's paywall, so every
 * surface says "payment required", not "upgrade". Without it such a
 * workspace resolved to the free plan, and a public surface answered with
 * its own feature gate: a 403 "upgrade" to a caller who cannot upgrade
 * anything (a site visitor, an agent) and that no client treats as a billing
 * state.
 */
export async function resolveWorkspaceBilling(
  db: Pick<ReturnType<typeof useDatabaseProvider>, 'getActivePaymentAccount'>,
  workspace: { id: string, type?: unknown, plan?: unknown, overage_settings?: unknown },
  options: { requireAccess?: boolean } = {},
): Promise<WorkspaceBilling> {
  const storedOverage = (workspace.overage_settings as Record<string, boolean> | null | undefined) ?? {}

  // Profiles without a subscription state machine: the operator (or the
  // fixed tier) decides the plan and nothing is billed, so nothing locks.
  if (resolveDeployment().planSource !== 'subscription') {
    return {
      state: 'subscribed',
      effectivePlan: getWorkspacePlan({ plan: (workspace.plan as string | null) ?? null }),
      overageSettings: storedOverage,
    }
  }

  const account = await db.getActivePaymentAccount(workspace.id)
  const row: WorkspaceBillingRow = {
    type: (workspace.type as string | undefined) ?? '',
    plan: (workspace.plan as string | null) ?? null,
    payment_account: (account as unknown as PaymentAccountState | null) ?? null,
    overage_settings: storedOverage,
  }
  const state = resolveBillingState(row)
  if (options.requireAccess && isBillingLocked(state)) {
    throw createError({
      statusCode: 402,
      message: errorMessage('billing.payment_required'),
      data: { code: 'payment_required', billingState: state, requiresCheckout: true },
    })
  }
  return {
    state,
    effectivePlan: getEffectivePlan(row),
    overageSettings: withoutLockedOverage(storedOverage, resolveOverageLocks(account as OverageLockAccount | null)),
  }
}
