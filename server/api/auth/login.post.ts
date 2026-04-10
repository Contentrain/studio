/**
 * POST /api/auth/login
 *
 * Initiates an OAuth login flow. Returns a redirect URL the client should open.
 *
 * Two modes:
 *   1. Web (default): reads { provider, redirectTo } from request body.
 *      Stores CSRF state in encrypted cookie, uses siteUrl as redirect base.
 *   2. CLI: reads provider, redirect_uri, state from query params.
 *      redirect_uri must be a localhost callback (port 9876-9899).
 *      State is caller-supplied (CLI manages its own CSRF).
 */

/** Validates that a redirect URI is an allowed CLI localhost callback. */
function isAllowedCliRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri)
    if (parsed.protocol !== 'http:') return false
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false
    const port = Number(parsed.port)
    if (port < 9876 || port > 9899) return false
    if (parsed.pathname !== '/callback') return false
    return true
  }
  catch {
    return false
  }
}

export default defineEventHandler(async (event) => {
  // Rate limit: 10 login requests per minute per IP
  const ip = getClientIp(event)
  const rateCheck = await checkRateLimit(`auth-login:${ip}`, 10, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('auth.rate_limited') })

  const query = getQuery(event) as { provider?: string, redirect_uri?: string, state?: string }
  const isCli = !!(query.provider && query.redirect_uri)

  let provider: string
  let redirectTo: string

  if (isCli) {
    // ── CLI flow ──
    provider = query.provider!

    if (!isAllowedCliRedirectUri(query.redirect_uri!)) {
      throw createError({
        statusCode: 400,
        message: 'redirect_uri must be http://127.0.0.1:{9876-9899}/callback',
      })
    }

    // CLI supplies the full redirect URI — pass it directly to the provider
    redirectTo = query.redirect_uri!
  }
  else {
    // ── Web flow (existing) ──
    const body = await readBody<{ provider: string, redirectTo?: string }>(event)
    provider = body.provider
    redirectTo = body.redirectTo || '/auth/callback'
  }

  if (!provider || !['github', 'google'].includes(provider)) {
    throw createError({
      statusCode: 400,
      message: errorMessage('auth.invalid_provider'),
    })
  }

  const authProvider = useAuthProvider()
  const result = await authProvider.getOAuthRedirectUrl(
    provider as 'github' | 'google',
    redirectTo,
  )

  if (isCli) {
    // CLI manages its own state — don't set cookie
    return { url: result.url, state: query.state || result.state }
  }

  // Web: store provider-generated state in encrypted cookie for validation on callback
  if (result.state) {
    await setAuthState(event, result.state)
  }

  return result
})
