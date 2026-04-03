/**
 * Reject (delete) a content branch.
 * Requires reviewer, admin, or owner role.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const branch = getRouterParam(event, 'branch')

  if (!workspaceId || !projectId || !branch)
    throw createError({ statusCode: 400, message: errorMessage('validation.branch_params_required') })

  // Only cr/* branches can be rejected (contentrain branch is permanent)
  if (branch === 'contentrain')
    throw createError({ statusCode: 403, message: errorMessage('branches.permanent_branch') })
  if (!branch.startsWith('cr/'))
    throw createError({ statusCode: 400, message: errorMessage('branches.contentrain_only') })

  // Role check: only reviewer+ can reject
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('reject_branch'))
    throw createError({ statusCode: 403, message: errorMessage('branches.reject_forbidden') })

  const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)

  const engine = createContentEngine({ git, contentRoot, projectId })
  await engine.rejectBranch(branch)

  // Emit webhook event (fire-and-forget)
  emitWebhookEvent(projectId, workspaceId, 'branch.rejected', {
    branch,
    source: 'api',
  }).catch(() => {})

  return { rejected: true }
})
