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
  const client = db.getUserClient(session.accessToken)

  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  const admin = db.getAdminClient()
  const { data: project } = await admin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found_in_workspace') })

  const { error } = await client
    .from('project_members')
    .delete()
    .eq('id', memberId)
    .eq('project_id', projectId)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return { deleted: true }
})
