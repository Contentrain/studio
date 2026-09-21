/**
 * PATCH /api/workspaces/:workspaceId/overage-settings
 *
 * Toggle overage billing per category.
 * Only workspace owner/admin can modify. Requires active paid subscription.
 *
 * Body: { ai_messages?: boolean, api_messages?: boolean, cdn_bandwidth?: boolean,
 *         form_submissions?: boolean, media_storage?: boolean }
 */

import { OVERAGE_SETTINGS_KEYS, OVERAGE_PRICING } from '../../../../shared/utils/license'
import { isOverageSellable } from '../../../../server/utils/overage'

/** settingsKey → limitKey, so a toggle can be checked against its limit. */
const LIMIT_KEY_BY_SETTINGS_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(OVERAGE_PRICING).map(([limitKey, pricing]) => [pricing.settingsKey, limitKey]),
)

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<Record<string, boolean>>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  // Only owner/admin can change overage settings
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
  const status = (account?.subscription_status as string | null) ?? null
  const hasActiveSubscription = ['trialing', 'active', 'past_due'].includes(status ?? '')
  if (!hasActiveSubscription || !account?.customer_id) {
    throw createError({ statusCode: 402, message: errorMessage('billing.overage_requires_subscription') })
  }

  // Free plan cannot enable overages
  if (workspace.plan === 'free') {
    throw createError({ statusCode: 403, message: errorMessage('billing.overage_requires_subscription') })
  }

  // Validate keys — only accept known overage settings keys
  const validUpdates: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(body)) {
    if (!OVERAGE_SETTINGS_KEYS.includes(key))
      throw createError({ statusCode: 400, message: errorMessage('validation.invalid_field', { field: key }) })
    if (typeof value !== 'boolean')
      throw createError({ statusCode: 400, message: errorMessage('validation.invalid_field', { field: key }) })
    // Refuse to record a `true` the billing side cannot honour. Storing it
    // would show the customer an overage they are not actually being sold.
    const limitKey = LIMIT_KEY_BY_SETTINGS_KEY[key]
    if (value && limitKey && !isOverageSellable(limitKey))
      throw createError({ statusCode: 409, message: errorMessage('billing.overage_not_available') })
    validUpdates[key] = value
  }

  if (Object.keys(validUpdates).length === 0)
    throw createError({ statusCode: 400, message: errorMessage('validation.no_fields_to_update') })

  // Merge with existing settings
  const existing = (workspace.overage_settings as Record<string, boolean>) ?? {}
  const merged = { ...existing, ...validUpdates }

  await db.updateWorkspace('', workspaceId, { overage_settings: merged })

  return { overageSettings: merged }
})
