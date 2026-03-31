import { trackEnterpriseCdnUsage } from '../../../../utils/enterprise'
import { useDatabaseProvider } from '../../../../utils/providers'

/**
 * Public CDN endpoint — serves content from CDN storage.
 *
 * Auth: Bearer API key (not session-based)
 * Cache: ETag + Cache-Control headers
 * Plan: requires cdn.delivery feature
 */
export default defineEventHandler(async (event) => {
  const authHeader = getHeader(event, 'authorization')
  const { projectId, keyId, rateLimitPerHour, allowedOrigins } = await validateCDNKey(authHeader)

  const routeProjectId = getRouterParam(event, 'projectId')
  if (routeProjectId !== projectId)
    throw createError({ statusCode: 403, message: errorMessage('cdn.key_mismatch') })

  // CORS origin check (if allowed_origins configured)
  if (allowedOrigins.length > 0) {
    const origin = getHeader(event, 'origin')
    if (origin && !allowedOrigins.includes(origin))
      throw createError({ statusCode: 403, message: errorMessage('cdn.origin_not_allowed') })
  }

  // Plan check
  const admin = useDatabaseProvider().getAdminClient()
  const { data: project } = await admin
    .from('projects')
    .select('workspace_id, cdn_enabled')
    .eq('id', projectId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  if (!project.cdn_enabled)
    throw createError({ statusCode: 403, message: errorMessage('cdn.not_enabled') })

  const { data: workspace } = await admin
    .from('workspaces')
    .select('plan')
    .eq('id', project.workspace_id)
    .single()

  if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'cdn.delivery'))
    throw createError({ statusCode: 403, message: errorMessage('cdn.upgrade') })

  // Rate limiting per-key (uses stored limit from DB)
  const rateCheck = checkRateLimit(`cdn:${keyId}`, rateLimitPerHour, 3600_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('rate.limit_exceeded') })
  setResponseHeader(event, 'X-RateLimit-Remaining', String(rateCheck.remaining))

  // Get content from CDN storage
  const cdn = useCDNProvider()
  if (!cdn)
    throw createError({ statusCode: 503, message: errorMessage('cdn.storage_not_configured') })

  const path = (getRouterParam(event, 'path') ?? '').replace(/^\//, '')
  if (!path)
    throw createError({ statusCode: 400, message: errorMessage('cdn.path_required') })

  // ETag conditional request
  const ifNoneMatch = getHeader(event, 'if-none-match')

  // Media files served as-is, content files default to .json
  const isMediaPath = path.startsWith('media/') || path === '_media_manifest.json'
  const resolvedPath = isMediaPath || path.endsWith('.json') ? path : `${path}.json`
  const result = await cdn.getObject(projectId, resolvedPath)

  if (!result)
    throw createError({ statusCode: 404, message: errorMessage('cdn.content_not_found') })

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

  // Track CDN usage (fire-and-forget, Business+ feature)
  if (hasFeature(getWorkspacePlan(workspace ?? {}), 'cdn.metering')) {
    void trackEnterpriseCdnUsage(projectId, keyId, result.data.length)
  }

  // Return binary data as-is, JSON/text as string
  if (result.contentType === 'application/json' || result.contentType.startsWith('text/')) {
    return result.data.toString('utf-8')
  }

  // Binary content — return Buffer directly
  return result.data
})
