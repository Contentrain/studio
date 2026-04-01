/**
 * POST /api/workspaces/:workspaceId/select-plan
 *
 * Allows workspace owner/admin to select a plan (starter or pro).
 * During trial: saves preferred plan.
 * After trial: requires Stripe checkout (handled by billing routes).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')!

  const body = await readBody<{ plan: string }>(event)

  if (!body.plan || !['starter', 'pro'].includes(body.plan)) {
    throw createError({
      statusCode: 400,
      message: 'Plan must be starter or pro.',
    })
  }

  // Only owner/admin can change plan
  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    workspaceId,
    ['owner', 'admin'],
  )

  if (!workspace) {
    throw createError({
      statusCode: 403,
      message: errorMessage('auth.forbidden'),
    })
  }

  // Update the workspace plan
  const updated = await db.updateWorkspace(
    session.accessToken,
    workspaceId,
    { plan: body.plan },
  )

  return updated
})
