/**
 * Remove a member from a project.
 * Only workspace owner/admin can remove project members.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const memberId = getRouterParam(event, 'memberId')

  if (!workspaceId || !projectId || !memberId)
    throw createError({ statusCode: 400, message: errorMessage('validation.member_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found_in_workspace') })

  await db.deleteProjectMember(projectId, memberId)

  return { deleted: true }
})
