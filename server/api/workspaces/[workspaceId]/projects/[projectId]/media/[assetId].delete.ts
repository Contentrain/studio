/**
 * Delete a media asset and all its variants from R2 + DB.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const assetId = getRouterParam(event, 'assetId')

  if (!workspaceId || !projectId || !assetId)
    throw createError({ statusCode: 400, message: 'workspaceId, projectId, and assetId are required' })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: 'Media storage not configured' })

  // Verify asset belongs to project
  const existing = await media.getAsset(assetId)
  if (!existing || existing.projectId !== projectId)
    throw createError({ statusCode: 404, message: 'Asset not found' })

  await media.delete(projectId, assetId)

  return { deleted: true }
})
