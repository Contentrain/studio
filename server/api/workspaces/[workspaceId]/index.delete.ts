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
    throw createError({ statusCode: 400, message: 'workspaceId is required' })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner'])

  // Fetch workspace and verify ownership
  const admin = useSupabaseAdmin()
  const { data: workspace } = await admin
    .from('workspaces')
    .select('id, type, owner_id')
    .eq('id', workspaceId)
    .single()

  if (!workspace)
    throw createError({ statusCode: 404, message: 'Workspace not found' })

  if (workspace.type === 'primary')
    throw createError({ statusCode: 400, message: 'Cannot delete primary workspace' })

  if (workspace.owner_id !== session.user.id)
    throw createError({ statusCode: 403, message: 'Only the workspace owner can delete it' })

  // Clean R2 storage for all projects
  const { data: projects } = await admin
    .from('projects')
    .select('id')
    .eq('workspace_id', workspaceId)

  const cdn = useCDNProvider()
  if (cdn && projects?.length) {
    for (const project of projects) {
      try {
        await cdn.deletePrefix(project.id, '')
      }
      catch {
        // R2 cleanup failure should not block deletion
      }
    }
  }

  // Delete workspace — CASCADE handles all child records
  const { error } = await admin
    .from('workspaces')
    .delete()
    .eq('id', workspaceId)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return { deleted: true }
})
