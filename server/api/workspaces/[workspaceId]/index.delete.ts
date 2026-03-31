/**
 * Delete a workspace and all its projects.
 *
 * Only the workspace owner can delete. Primary (personal) workspace
 * cannot be deleted. Cleans R2 storage for all projects before
 * DB cascade delete.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner'])

  // Fetch workspace and verify ownership
  const workspace = await db.getWorkspaceById(workspaceId, 'id, type, owner_id')

  if (!workspace)
    throw createError({ statusCode: 404, message: errorMessage('workspace.not_found') })

  if (workspace.type === 'primary')
    throw createError({ statusCode: 400, message: errorMessage('workspace.cannot_delete_primary') })

  if (workspace.owner_id !== session.user.id)
    throw createError({ statusCode: 403, message: errorMessage('workspace.owner_only_delete') })

  // Clean R2 storage for all projects
  const projects = await db.listWorkspaceProjects(session.accessToken, workspaceId)

  const cdn = useCDNProvider()
  if (cdn && projects?.length) {
    for (const project of projects) {
      try {
        await cdn.deletePrefix(project.id as string, '')
      }
      catch {
        // R2 cleanup failure should not block deletion
      }
    }
  }

  // Delete workspace — CASCADE handles all child records
  const admin = db.getAdminClient()
  const { error } = await admin
    .from('workspaces')
    .delete()
    .eq('id', workspaceId)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return { deleted: true }
})
