/**
 * Serve media asset binary for preview in Studio UI.
 * Proxies from R2 storage with proper content-type headers.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const assetId = getRouterParam(event, 'assetId')

  if (!workspaceId || !projectId || !assetId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  const asset = await media.getAsset(assetId)
  if (!asset || asset.projectId !== projectId)
    throw createError({ statusCode: 404, message: errorMessage('media.asset_not_found') })

  const cdn = useCDNProvider()
  if (!cdn)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  // Determine which variant to serve (query param or original)
  const query = getQuery(event) as { variant?: string }
  const path = query.variant && asset.variants[query.variant]
    ? asset.variants[query.variant].path
    : asset.originalPath

  const result = await cdn.getObject(projectId, path)
  if (!result)
    throw createError({ statusCode: 404, message: errorMessage('media.file_not_found_storage') })

  setResponseHeader(event, 'Content-Type', result.contentType)
  setResponseHeader(event, 'Cache-Control', 'private, max-age=3600')
  if (result.etag)
    setResponseHeader(event, 'ETag', result.etag)

  return result.data
})
