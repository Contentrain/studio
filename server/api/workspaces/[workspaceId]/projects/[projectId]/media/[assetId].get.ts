/**
 * Get a single media asset with full metadata, variants, and usage info.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const assetId = getRouterParam(event, 'assetId')

  if (!workspaceId || !projectId || !assetId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const ws = await db.getWorkspaceById(workspaceId, 'plan')
  const plan = getWorkspacePlan(ws ?? {})
  if (!hasFeature(plan, 'media.library'))
    throw createError({ statusCode: 403, message: errorMessage('media.library_upgrade') })

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  const asset = await media.getAsset(assetId)
  if (!asset || asset.projectId !== projectId)
    throw createError({ statusCode: 404, message: errorMessage('media.asset_not_found') })

  return asset
})
