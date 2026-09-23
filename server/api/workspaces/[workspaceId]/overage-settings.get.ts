/**
 * GET /api/workspaces/:workspaceId/overage-settings
 *
 * Returns overage preferences, plan limits, and overage pricing for the workspace.
 * Used by the usage dashboard to render overage toggles and pricing info.
 */

import { OVERAGE_PRICING, getPlanLimitForPlan, normalizePlan } from '../../../../shared/utils/license'
import { isOverageSellable } from '../../../../server/utils/overage'
import { resolveCreditUnit } from '../../../../server/utils/billing'
import { creditTermsFor, isCreditLimitKey } from '../../../../shared/utils/credit-unit'
import { resolveOverageLocks } from '../../../../server/utils/overage-lock'
import type { OverageLockAccount } from '../../../../server/utils/overage-lock'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    workspaceId,
    ['owner', 'admin'],
    'id, plan, overage_settings',
  )

  if (!workspace)
    throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })

  const account = await db.getActivePaymentAccount(workspaceId)
  const plan = normalizePlan(workspace.plan as string | null)
  const overageSettings = (workspace.overage_settings as Record<string, boolean>) ?? {}
  const hasPaymentMethod = !!account?.customer_id
  const accountStatus = (account?.subscription_status as string | null) ?? null
  const hasActiveSubscription = ['trialing', 'active', 'past_due'].includes(accountStatus ?? '')

  const locks = resolveOverageLocks(account as OverageLockAccount | null)
  // Credit limits and every overage price in the terms the account's own
  // product was sold with (`credit-unit.ts`): a pre-v2 subscription is shown
  // its $0.03 credits and $0.08 overage, not the v2 catalog's.
  const terms = creditTermsFor(resolveCreditUnit(account as { credit_unit?: unknown } | null))

  const categories = Object.entries(OVERAGE_PRICING).map(([limitKey, pricing]) => ({
    limitKey,
    settingsKey: pricing.settingsKey,
    unit: pricing.unit,
    unitPrice: terms.overagePrice(limitKey) ?? pricing.price,
    planLimit: isCreditLimitKey(limitKey) ? terms.creditLimit(plan, limitKey) : getPlanLimitForPlan(plan, limitKey),
    enabled: isOverageSellable(limitKey) && !locks[pricing.settingsKey] && overageSettings[pricing.settingsKey] === true,
    /** False → hard cap; the client hides or disables the toggle. */
    sellable: isOverageSellable(limitKey),
    /** Set → the toggle is off and cannot be turned on yet (why, and until when). */
    lock: locks[pricing.settingsKey] ?? null,
  }))

  return {
    overageSettings,
    categories,
    canEnableOverage: hasPaymentMethod && hasActiveSubscription && plan !== 'free',
  }
})
