/**
 * Get branch health status for a project.
 * Returns cached status or performs a fresh check.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  await requireProjectAccess(session.user.id, workspaceId, projectId, session.accessToken)

  const cached = getHealthStatus(projectId)
  if (cached) return cached

  const { git } = await resolveProjectContext(workspaceId, projectId)
  return checkBranchHealth(git, projectId)
})
