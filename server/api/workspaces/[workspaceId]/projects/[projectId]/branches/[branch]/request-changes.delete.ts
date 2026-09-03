/**
 * Mark an open change request on a branch as addressed. Any project member
 * who can see the branch may resolve it (the author usually does); the row
 * is kept as history until the branch is merged or rejected.
 *
 * DELETE /api/workspaces/{workspaceId}/projects/{projectId}/branches/{branch}/request-changes
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

  await requireProjectAccess(session.user.id, workspaceId, projectId, session.accessToken)

  const db = useDatabaseProvider()
  const existing = await db.getBranchChangeRequest(projectId, branch)
  if (!existing)
    throw createError({ statusCode: 404, message: errorMessage('branches.request_not_found') })

  await db.resolveBranchChangeRequest(projectId, branch, session.user.id)
  return { branch, resolved: true }
})
