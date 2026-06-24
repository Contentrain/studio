import { trackEnterpriseCdnUsage, trackEnterprisePublicCdnUsage } from '../../../../utils/enterprise'

/**
 * CDN delivery endpoint — serves content + media from CDN storage.
 *
 * Two auth modes:
 *  - Keyed (default): Bearer API key (`crn_...`). Used for content JSON, the
 *    media manifest, and any media fetch that carries a key. Per-key rate
 *    limit + CORS origin check + per-key bandwidth metering.
 *  - Public media: a no-key GET of a `media/*` binary when the project has
 *    `cdn_public_media` enabled. Lets a browser `<img src>` load assets on a
 *    published site (a key can't live in an <img> tag). Per-project+IP rate
 *    limited. Content JSON and the manifest are never public — only media
 *    binaries.
 *
 * Both modes still require `cdn_enabled` and the `cdn.delivery` plan feature,
 * so public media changes the auth model, not the entitlement.
 *
 * Cache: ETag + Cache-Control headers.
 */
export default defineEventHandler(async (event) => {
  const routeProjectId = getRouterParam(event, 'projectId')
  if (!routeProjectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const path = (getRouterParam(event, 'path') ?? '').replace(/^\/+/, '')
  if (!path)
    throw createError({ statusCode: 400, message: errorMessage('cdn.path_required') })

  // Only media binaries are ever eligible for keyless public delivery.
  const isMediaBinary = path.startsWith('media/')
  const authHeader = getHeader(event, 'authorization')
  const hasKey = authHeader?.startsWith('Bearer crn_') ?? false

  let projectId = routeProjectId
  let keyId: string | null = null

  if (hasKey) {
    // ── Keyed delivery ── validate + ownership + CORS + per-key rate limit.
    // Runs before any project lookup so a bad key/origin fails fast.
    const validated = await validateCDNKey(authHeader)
    projectId = validated.projectId
    if (routeProjectId !== projectId)
      throw createError({ statusCode: 403, message: errorMessage('cdn.key_mismatch') })

    // CORS origin check (if allowed_origins configured)
    if (validated.allowedOrigins.length > 0) {
      const origin = getHeader(event, 'origin')
      if (origin && !validated.allowedOrigins.includes(origin))
        throw createError({ statusCode: 403, message: errorMessage('cdn.origin_not_allowed') })
    }

    keyId = validated.keyId
    const rateCheck = await checkRateLimit(`cdn:${keyId}`, validated.rateLimitPerHour, 3600_000)
    if (!rateCheck.allowed)
      throw createError({ statusCode: 429, message: errorMessage('rate.limit_exceeded') })
    setResponseHeader(event, 'X-RateLimit-Remaining', String(rateCheck.remaining))
  }
  else if (!isMediaBinary) {
    // Keyless content / manifest is never public — require a key (throws 401).
    await validateCDNKey(authHeader)
  }
  // else: keyless media → public candidate, validated against the project flag below.

  // Project gate (both modes): cdn_enabled, plus cdn_public_media for keyless.
  const db = useDatabaseProvider()
  const project = await db.getProjectById(projectId, 'workspace_id, cdn_enabled, cdn_public_media')

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  if (!project.cdn_enabled)
    throw createError({ statusCode: 403, message: errorMessage('cdn.not_enabled') })

  if (!hasKey) {
    // ── Public media delivery (keyless) ── isMediaBinary is guaranteed here
    // (keyless content already required a key above). A project that opted out
    // of public media still requires a key (throws 401).
    if (project.cdn_public_media !== true)
      await validateCDNKey(authHeader)

    // No key to scope by — rate limit per project + client IP.
    const ip = getClientIp(event)
    const rateCheck = await checkRateLimit(`cdnpub:${projectId}:${ip}`, 600, 60_000)
    if (!rateCheck.allowed) {
      setResponseHeader(event, 'Retry-After', Math.ceil(rateCheck.retryAfterMs / 1000))
      throw createError({ statusCode: 429, message: errorMessage('rate.limit_exceeded') })
    }
  }

  // Plan gate — cdn.delivery entitlement applies to both auth modes.
  const workspace = await db.getWorkspaceById(project.workspace_id as string, 'plan')
  const plan = getWorkspacePlan(workspace ?? {})
  if (!hasFeature(plan, 'cdn.delivery'))
    throw createError({ statusCode: 403, message: errorMessage('cdn.upgrade', getUpgradeParams(plan)) })

  // Get content from CDN storage
  const cdn = useCDNProvider()
  if (!cdn)
    throw createError({ statusCode: 503, message: errorMessage('cdn.storage_not_configured') })

  // ETag conditional request
  const ifNoneMatch = getHeader(event, 'if-none-match')

  // Media files served as-is, content files default to .json
  const isMediaPath = isMediaBinary || path === '_media_manifest.json'
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
  if (keyId)
    setResponseHeader(event, 'X-Contentrain-Key', keyId.substring(0, 8))

  // Track CDN usage (fire-and-forget, Business+ feature). Keyed requests are
  // attributed to the key; keyless public-media requests land in the project's
  // NULL-key bucket so public bandwidth still counts toward project totals.
  if (hasFeature(plan, 'cdn.metering')) {
    if (keyId)
      void trackEnterpriseCdnUsage(projectId, keyId, result.data.length)
    else
      void trackEnterprisePublicCdnUsage(projectId, result.data.length)
  }

  // Return binary data as-is, JSON/text as string
  if (result.contentType === 'application/json' || result.contentType.startsWith('text/'))
    return result.data.toString('utf-8')

  // Binary content — return Buffer directly
  return result.data
})
