/**
 * GET /api/workspaces/:workspaceId/overage-history
 *
 * Returns past overage billing entries.
 * Optionally filtered by billing period (?period=2026-04).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const query = getQuery(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  // Owner/admin only
  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    workspaceId,
    ['owner', 'admin'],
    'id',
  )

  if (!workspace)
    throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })

  // Default to current month if no period specified
  const period = (query.period as string) ?? new Date().toISOString().substring(0, 7)

  const entries = await db.getOverageBillingLog(workspaceId, period)

  return { billingPeriod: period, entries }
})
