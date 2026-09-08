/**
 * Remove the project's deploy hook. Workspace owner/admin.
 *
 * DELETE /api/workspaces/{workspaceId}/projects/{projectId}/deploy
 */

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  await db.setProjectDeployTarget(projectId, null)
  return { removed: true }
})
