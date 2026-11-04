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
import { getEffectivePlan, isBillingLocked, isPrepaidLive, resolveBillingState, resolveCreditUnit, resolveTrialContext } from './billing'
import { CURRENT_CREDIT_UNIT } from '../../shared/utils/credit-unit'
import type { CreditUnit } from '../../shared/utils/credit-unit'
import type { BillingState, PaymentAccountState, WorkspaceBillingRow } from './billing'
import { getWorkspacePlan } from './license'
import { resolveDeployment } from './deployment'
import { prepaidOverageLocks, resolveOverageLocks, withoutLockedOverage } from './overage-lock'
import type { OverageLockAccount } from './overage-lock'
import type { StudioPlan, TrialContext } from '../../shared/utils/license'

/** Workspace columns `resolveWorkspaceBilling` reads. Select them with the rest. */
export const WORKSPACE_BILLING_COLUMNS = ['type', 'plan', 'overage_settings', 'prepaid_until', 'prepaid_plan'] as const

type BillingDb = Pick<ReturnType<typeof useDatabaseProvider>, 'getActivePaymentAccount' | 'getWorkspaceById'>

/**
 * The workspace's prepaid year (migration 055). Callers select their own workspace columns; one that left these
 * out gets them read here, so no caller can miss a prepaid year and serve the workspace as free.
 */
async function prepaidColumns(db: BillingDb, workspace: { id: string, prepaid_until?: unknown, prepaid_plan?: unknown }): Promise<{ prepaid_until: string | null, prepaid_plan: string | null }> {
  if (workspace.prepaid_until !== undefined)
    return { prepaid_until: (workspace.prepaid_until as string | null) ?? null, prepaid_plan: (workspace.prepaid_plan as string | null) ?? null }
  const row = await db.getWorkspaceById(workspace.id, 'prepaid_until, prepaid_plan')
  return { prepaid_until: (row?.prepaid_until as string | null) ?? null, prepaid_plan: (row?.prepaid_plan as string | null) ?? null }
}

export interface WorkspaceBilling {
  state: BillingState
  /** The plan limits and features are enforced against. */
  effectivePlan: StudioPlan
  /** `overage_settings` with every toggle the subscription cannot bill turned off. */
  overageSettings: Record<string, boolean>
  /** Trial state and origin, for `applyTrialCap`. */
  trial: TrialContext
  /** The credit unit the account is billed in (`credit-unit.ts`). */
  creditUnit: CreditUnit
}

/**
 * `requireAccess`: refuse a workspace whose billing is locked (trial ended
 * unpaid, grace period over, cancellation took effect) with 402 and the
 * billing middleware's `code`, so every surface says "payment required", not
 * "upgrade". Unlike the in-app paywall it leaves out `billingState`: these
 * callers are site visitors and agents (a form, a comment box, a CDN key
 * shipped in a page), and which of the three ended is the owner's business. Without it such a
 * workspace resolved to the free plan, and a public surface answered with
 * its own feature gate: a 403 "upgrade" to a caller who cannot upgrade
 * anything (a site visitor, an agent) and that no client treats as a billing
 * state.
 */
export async function resolveWorkspaceBilling(
  db: BillingDb,
  workspace: { id: string, type?: unknown, plan?: unknown, overage_settings?: unknown, prepaid_until?: unknown, prepaid_plan?: unknown },
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
      trial: { trialing: false, origin: 'standard' },
      creditUnit: CURRENT_CREDIT_UNIT,
    }
  }

  const [account, prepaid] = await Promise.all([db.getActivePaymentAccount(workspace.id), prepaidColumns(db, workspace)])
  const row: WorkspaceBillingRow = {
    type: (workspace.type as string | undefined) ?? '',
    plan: (workspace.plan as string | null) ?? null,
    payment_account: (account as unknown as PaymentAccountState | null) ?? null,
    overage_settings: storedOverage,
    ...prepaid,
  }
  const state = resolveBillingState(row)
  if (options.requireAccess && isBillingLocked(state)) {
    throw createError({
      statusCode: 402,
      message: errorMessage('billing.payment_required'),
      data: { code: 'payment_required', requiresCheckout: true },
    })
  }
  return {
    state,
    effectivePlan: getEffectivePlan(row),
    overageSettings: withoutLockedOverage(storedOverage, state === 'prepaid' ? prepaidOverageLocks(prepaid.prepaid_until) : resolveOverageLocks(account as OverageLockAccount | null)),
    // A subscription waiting beside a prepaid year is not a trial of the workspace.
    trial: resolveTrialContext(state, state === 'prepaid' ? null : account as { plugin_metadata?: unknown } | null),
    creditUnit: resolveCreditUnit(account as { credit_unit?: unknown } | null),
  }
}

/**
 * Stored `overage_settings` as the subscription can bill them, for a
 * caller that read the row itself (outside the billing middleware and
 * `resolveWorkspaceBilling`): every toggle the account cannot invoice is
 * off. The account is read only when some toggle is on; an unreadable
 * account turns them all off — usage stops at the plan, never past it unbilled.
 */
export async function billableOverageSettings(
  db: BillingDb,
  workspaceId: string,
  stored: unknown,
): Promise<Record<string, boolean>> {
  const settings = stored && typeof stored === 'object' ? stored as Record<string, boolean> : null
  if (!settings || !Object.values(settings).includes(true)) return settings ?? {}
  // No subscription state machine (self-hosted, dedicated): nothing is billed, nothing locks.
  if (resolveDeployment().planSource !== 'subscription') return settings
  try {
    const [account, prepaid] = await Promise.all([db.getActivePaymentAccount(workspaceId), prepaidColumns(db, { id: workspaceId })])
    if (isPrepaidLive(prepaid.prepaid_until)) return withoutLockedOverage(settings, prepaidOverageLocks(prepaid.prepaid_until))
    return withoutLockedOverage(settings, resolveOverageLocks(account as OverageLockAccount | null))
  }
  catch {
    // Unreadable billing: serve within the plan's own limit, never past it unbilled.
    return Object.fromEntries(Object.keys(settings).map(key => [key, false]))
  }
}
