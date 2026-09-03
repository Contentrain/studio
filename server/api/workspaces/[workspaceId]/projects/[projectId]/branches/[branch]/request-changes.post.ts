/**
 * Send a pending content branch back to its author with a comment.
 * Requires reviewer, admin, or owner role (same gate as merge/reject).
 * The branch stays open; merging or rejecting it later clears the request.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/branches/{branch}/request-changes
 * body { comment: string }
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const branch = getRouterParam(event, 'branch', { decode: true })

  if (!workspaceId || !projectId || !branch)
    throw createError({ statusCode: 400, message: errorMessage('validation.branch_params_required') })
  if (!branch.startsWith('cr/'))
    throw createError({ statusCode: 400, message: errorMessage('branches.contentrain_only') })

  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('request_changes'))
    throw createError({ statusCode: 403, message: errorMessage('branches.request_forbidden') })

  const body = await readBody<{ comment?: unknown }>(event)
  const comment = typeof body?.comment === 'string' ? body.comment.trim().slice(0, 4000) : ''
  if (!comment)
    throw createError({ statusCode: 400, message: errorMessage('branches.request_comment_required') })

  const db = useDatabaseProvider()
  const request = await db.requestBranchChanges({ projectId, workspaceId, branch, comment, requestedBy: session.user.id })

  emitWebhookEvent(projectId, workspaceId, 'branch.changes_requested', {
    branch,
    comment,
    requestedBy: session.user.id,
    source: 'api',
  }).catch(() => {})

  return {
    branch,
    changesRequested: {
      comment: String(request.comment),
      requestedBy: (request.requested_by as string | null) ?? null,
      requestedAt: String(request.requested_at),
    },
  }
})
