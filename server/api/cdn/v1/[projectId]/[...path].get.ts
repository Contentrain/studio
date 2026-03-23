/**
 * Public CDN endpoint — serves content from CDN storage.
 *
 * Auth: Bearer API key (not session-based)
 * Cache: ETag + Cache-Control headers
 * Plan: requires cdn.delivery feature
 */
export default defineEventHandler(async (event) => {
  const authHeader = getHeader(event, 'authorization')
  const { projectId, keyId } = await validateCDNKey(authHeader)

  const routeProjectId = getRouterParam(event, 'projectId')
  if (routeProjectId !== projectId)
    throw createError({ statusCode: 403, message: 'API key does not match project' })

  // Plan check
  const admin = useSupabaseAdmin()
  const { data: project } = await admin
    .from('projects')
    .select('workspace_id, cdn_enabled')
    .eq('id', projectId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: 'Project not found' })

  if (!project.cdn_enabled)
    throw createError({ statusCode: 403, message: 'CDN is not enabled for this project' })

  const { data: workspace } = await admin
    .from('workspaces')
    .select('plan')
    .eq('id', project.workspace_id)
    .single()

  if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'cdn.delivery'))
    throw createError({ statusCode: 403, message: 'CDN delivery requires Pro plan or higher' })

  // Rate limiting per-key
  const rateCheck = checkRateLimit(`cdn:${keyId}`, 1000, 3600_000) // 1000 req/hour
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: 'Rate limit exceeded' })
  setResponseHeader(event, 'X-RateLimit-Remaining', String(rateCheck.remaining))

  // Get content from CDN storage
  const cdn = useCDNProvider()
  if (!cdn)
    throw createError({ statusCode: 503, message: 'CDN storage not configured' })

  const path = (getRouterParam(event, 'path') ?? '').replace(/^\//, '')
  if (!path)
    throw createError({ statusCode: 400, message: 'Path is required' })

  // ETag conditional request
  const ifNoneMatch = getHeader(event, 'if-none-match')

  const result = await cdn.getObject(projectId, path.endsWith('.json') ? path : `${path}.json`)

  if (!result)
    throw createError({ statusCode: 404, message: 'Content not found' })

  // 304 Not Modified
  if (ifNoneMatch && ifNoneMatch === result.etag) {
    setResponseStatus(event, 304)
    return ''
  }

  // Response headers
  setResponseHeader(event, 'Content-Type', result.contentType)
  setResponseHeader(event, 'Cache-Control', 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400')
  setResponseHeader(event, 'ETag', result.etag)
  setResponseHeader(event, 'X-Contentrain-Key', keyId.substring(0, 8))

  return result.data.toString('utf-8')
})
