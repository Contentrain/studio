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
    throw createError({ statusCode: 400, message: 'Missing required params' })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: 'Media storage not configured' })

  const asset = await media.getAsset(assetId)
  if (!asset || asset.projectId !== projectId)
    throw createError({ statusCode: 404, message: 'Asset not found' })

  const cdn = useCDNProvider()
  if (!cdn)
    throw createError({ statusCode: 503, message: 'Storage not configured' })

  // Determine which variant to serve (query param or original)
  const query = getQuery(event) as { variant?: string }
  const path = query.variant && asset.variants[query.variant]
    ? asset.variants[query.variant].path
    : asset.originalPath

  const result = await cdn.getObject(projectId, path)
  if (!result)
    throw createError({ statusCode: 404, message: 'File not found in storage' })

  setResponseHeader(event, 'Content-Type', result.contentType)
  setResponseHeader(event, 'Cache-Control', 'private, max-age=3600')
  if (result.etag)
    setResponseHeader(event, 'ETag', result.etag)

  return result.data
})
