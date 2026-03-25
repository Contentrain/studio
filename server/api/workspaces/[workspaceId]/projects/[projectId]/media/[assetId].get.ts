/**
 * Get a single media asset with full metadata, variants, and usage info.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const assetId = getRouterParam(event, 'assetId')

  if (!workspaceId || !projectId || !assetId)
    throw createError({ statusCode: 400, message: 'workspaceId, projectId, and assetId are required' })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const plan = getWorkspacePlan(await getWorkspace(client, workspaceId))
  if (!hasFeature(plan, 'media.library'))
    throw createError({ statusCode: 403, message: 'Media library requires Pro plan or higher' })

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: 'Media storage not configured' })

  const asset = await media.getAsset(assetId)
  if (!asset || asset.projectId !== projectId)
    throw createError({ statusCode: 404, message: 'Asset not found' })

  return asset
})
