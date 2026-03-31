/**
 * Update media asset metadata (alt text, tags, focal point).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const assetId = getRouterParam(event, 'assetId')

  if (!workspaceId || !projectId || !assetId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  // Verify asset belongs to project
  const existing = await media.getAsset(assetId)
  if (!existing || existing.projectId !== projectId)
    throw createError({ statusCode: 404, message: errorMessage('media.asset_not_found') })

  const body = await readBody<{
    alt?: string
    tags?: string[]
    focalPoint?: { x: number, y: number }
  }>(event)

  return media.updateMetadata(assetId, {
    alt: body.alt,
    tags: body.tags,
    focalPoint: body.focalPoint,
  })
})
