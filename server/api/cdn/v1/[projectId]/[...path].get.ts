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
 * Hot path: key/project/plan lookups are served from in-process TTL caches
 * (server/utils/cdn-delivery-cache.ts) — on a warm request the only remaining
 * round-trips are the Redis rate limit and the R2 read. All gates still run
 * per request; only their DB inputs are memoized.
 *
 * Cache: ETag + conditional R2 reads (304 without body transfer).
 * Cache-Control is split by auth mode — keyed responses are `private` so a
 * shared/edge cache can never replay keyed content to keyless clients;
 * only keyless public media is shared-cacheable.
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

  const authStart = Date.now()
  let projectId = routeProjectId
  let keyId: string | null = null
  let projectPromise: ReturnType<typeof cachedProjectDelivery> | null = null

  if (hasKey) {
    // ── Keyed delivery ── validate + ownership + CORS + per-key rate limit.
    // The project lookup starts in parallel (both are usually warm cache
    // hits; on a cold miss this halves the sequential round-trips). Key
    // errors keep precedence: the project promise gets a no-op catch so an
    // early 401 can't surface an unhandled rejection.
    projectPromise = cachedProjectDelivery(routeProjectId)
    projectPromise.catch(() => {})

    const validated = await cachedValidateCDNKey(authHeader)
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
    await cachedValidateCDNKey(authHeader)
  }
  // else: keyless media → public candidate, validated against the project flag below.

  // Project gate (both modes): cdn_enabled, plus cdn_public_media for keyless.
  const project = await (projectPromise ?? cachedProjectDelivery(projectId))

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  if (!project.cdn_enabled)
    throw createError({ statusCode: 403, message: errorMessage('cdn.not_enabled') })

  if (!hasKey) {
    // ── Public media delivery (keyless) ── isMediaBinary is guaranteed here
    // (keyless content already required a key above). A project that opted out
    // of public media still requires a key (throws 401).
    if (project.cdn_public_media !== true)
      await cachedValidateCDNKey(authHeader)

    // No key to scope by — rate limit per project + client IP.
    const ip = getClientIp(event)
    const rateCheck = await checkRateLimit(`cdnpub:${projectId}:${ip}`, 600, 60_000)
    if (!rateCheck.allowed) {
      setResponseHeader(event, 'Retry-After', Math.ceil(rateCheck.retryAfterMs / 1000))
      throw createError({ statusCode: 429, message: errorMessage('rate.limit_exceeded') })
    }
  }

  // Plan gate — cdn.delivery entitlement applies to both auth modes.
  const workspace = await cachedWorkspacePlan(project.workspace_id as string)
  const plan = getWorkspacePlan(workspace ?? {})
  if (!hasFeature(plan, 'cdn.delivery'))
    throw createError({ statusCode: 403, message: errorMessage('cdn.upgrade', getUpgradeParams(plan)) })

  // Get content from CDN storage
  const cdn = useCDNProvider()
  if (!cdn)
    throw createError({ statusCode: 503, message: errorMessage('cdn.storage_not_configured') })

  const authMs = Date.now() - authStart

  // Keyed responses must never enter a shared cache — a cached keyed body
  // would be replayable on the keyless URL (the cache key carries no key).
  const cacheControl = hasKey
    ? 'private, max-age=60'
    : 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400'

  // Conditional request — forwarded to R2 so a 304 skips the body transfer.
  const ifNoneMatch = getHeader(event, 'if-none-match')

  // Media files served as-is, content files default to .json
  const isMediaPath = isMediaBinary || path === '_media_manifest.json'
  const resolvedPath = isMediaPath || path.endsWith('.json') ? path : `${path}.json`

  const r2Start = Date.now()
  const result = await cdn.getObject(projectId, resolvedPath, ifNoneMatch ? { ifNoneMatch } : undefined)
  const r2Ms = Date.now() - r2Start

  setResponseHeader(event, 'Server-Timing', `auth;dur=${authMs}, r2;dur=${r2Ms}`)

  if (!result)
    throw createError({ statusCode: 404, message: errorMessage('cdn.content_not_found') })

  // 304 Not Modified — answered by R2's conditional read, no body transferred.
  if ('notModified' in result) {
    setResponseStatus(event, 304)
    setResponseHeader(event, 'Cache-Control', cacheControl)
    if (ifNoneMatch) setResponseHeader(event, 'ETag', ifNoneMatch)
    return ''
  }

  // 304 fallback for providers that ignore the ifNoneMatch option.
  if (ifNoneMatch && ifNoneMatch === result.etag) {
    setResponseStatus(event, 304)
    setResponseHeader(event, 'Cache-Control', cacheControl)
    setResponseHeader(event, 'ETag', result.etag)
    return ''
  }

  // Response headers
  setResponseHeader(event, 'Content-Type', result.contentType)
  setResponseHeader(event, 'Cache-Control', cacheControl)
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
