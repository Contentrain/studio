/**
 * Download the file as it was uploaded — byte for byte (`MediaAsset.sourcePath`).
 *
 * Project members only, through the session: the source is never part of public delivery (media-source.ts), and the
 * public media API does not return it. It may carry what the delivery master had stripped (camera, location), so it is
 * sent as an attachment, uncached.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const assetId = getRouterParam(event, 'assetId')

  if (!workspaceId || !projectId || !assetId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  if (role === 'member') {
    const pm = await db.getProjectMember(projectId, session.user.id)
    if (!pm) throw createError({ statusCode: 403, message: errorMessage('project.access_denied') })
  }

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  const asset = await media.getAsset(assetId)
  if (!asset || asset.projectId !== projectId)
    throw createError({ statusCode: 404, message: errorMessage('media.asset_not_found') })

  // No stored source: an asset from before sources were kept, or a file that is stored as uploaded anyway.
  if (!asset.sourcePath)
    throw createError({ statusCode: 404, message: errorMessage('media.source_not_stored') })

  const cdn = useCDNProvider()
  if (!cdn)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  const result = await cdn.getObject(projectId, asset.sourcePath)
  // `notModified` can't occur without an ifNoneMatch option — type guard only.
  if (!result || 'notModified' in result)
    throw createError({ statusCode: 404, message: errorMessage('media.file_not_found_storage') })

  const extension = asset.sourcePath.split('.').pop() ?? 'bin'
  const asciiName = `source.${extension}`
  setResponseHeader(event, 'Content-Type', result.contentType)
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(asset.filename)}`)
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')
  setResponseHeader(event, 'Content-Security-Policy', 'default-src \'none\'; sandbox')

  return result.data
})
