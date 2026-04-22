/**
 * GET /api/workspaces/:workspaceId/overage-settings
 *
 * Returns overage preferences, plan limits, and overage pricing for the workspace.
 * Used by the usage dashboard to render overage toggles and pricing info.
 */

import { OVERAGE_PRICING, getPlanLimitForPlan, normalizePlan } from '../../../../shared/utils/license'

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

  const categories = Object.entries(OVERAGE_PRICING).map(([limitKey, pricing]) => ({
    limitKey,
    settingsKey: pricing.settingsKey,
    unit: pricing.unit,
    unitPrice: pricing.price,
    planLimit: getPlanLimitForPlan(plan, limitKey),
    enabled: overageSettings[pricing.settingsKey] === true,
  }))

  return {
    overageSettings,
    categories,
    canEnableOverage: hasPaymentMethod && hasActiveSubscription && plan !== 'free',
  }
})
