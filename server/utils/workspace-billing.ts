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

import { getEffectivePlan, resolveBillingState } from './billing'
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

export async function resolveWorkspaceBilling(
  db: Pick<ReturnType<typeof useDatabaseProvider>, 'getActivePaymentAccount'>,
  workspace: { id: string, type?: unknown, plan?: unknown, overage_settings?: unknown },
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
  return {
    state: resolveBillingState(row),
    effectivePlan: getEffectivePlan(row),
    overageSettings: withoutLockedOverage(storedOverage, resolveOverageLocks(account as OverageLockAccount | null)),
  }
}
