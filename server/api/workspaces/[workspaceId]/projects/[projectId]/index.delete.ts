/**
 * Delete a project from a workspace.
 *
 * Cleans up R2 storage (CDN + media), updates workspace storage quota,
 * then deletes the project row. DB cascades handle:
 * conversations, messages, project_members, cdn_builds, cdn_api_keys,
 * cdn_usage, media_assets, media_usage.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  const client = db.getUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  // Verify project belongs to workspace
  const admin = db.getAdminClient()
  const { data: project } = await admin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found_in_workspace') })

  // 1. Clean R2 storage (CDN content + media assets)
  const cdn = useCDNProvider()
  if (cdn) {
    try {
      await cdn.deletePrefix(projectId, '')
    }
    catch {
      // R2 cleanup failure should not block deletion
    }
  }

  // 2. Update workspace storage quota
  const { data: mediaSum } = await admin
    .from('media_assets')
    .select('size_bytes')
    .eq('project_id', projectId)

  if (mediaSum?.length) {
    const totalBytes = mediaSum.reduce((sum: number, a: { size_bytes: number | null }) => sum + (a.size_bytes ?? 0), 0)
    if (totalBytes > 0) {
      await admin.rpc('decrement_storage_bytes', {
        ws_id: workspaceId,
        bytes: totalBytes,
      })
    }
  }

  // 3. Delete project — CASCADE handles all child records
  const { error } = await admin
    .from('projects')
    .delete()
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return { deleted: true }
})
