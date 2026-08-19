/**
 * Server auth middleware.
 *
 * Reads the encrypted session cookie (provider-agnostic),
 * validates the token, auto-refreshes if expired,
 * and attaches the session to event.context.auth.
 */

const PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/magic-link',
  '/api/auth/magic/', // managed pair: GET verify landing (email click carries no session)
  '/api/auth/oauth/', // managed pair: OAuth dance legs (pre-session by definition)
  '/api/auth/verify',
  '/api/auth/refresh',
  '/api/auth/review-login', // managed pair: directory-review password login (env-gated, pre-session)
  // nuxt-auth-utils module session endpoint (GET/DELETE). The module's SSR
  // plugin fetches it on every server-rendered page load — logged-out
  // included — and the route self-authenticates via its own sealed cookie
  // (server-only `secure` data is never returned). Walling it behind the
  // Studio session just turns every logged-out SSR load into a 401.
  '/api/_auth/',
  '/api/health',
  '/api/webhooks/',
  '/api/cdn/',
  '/api/billing/webhook',
  // External API surfaces that authenticate themselves inside the route —
  // with a Bearer API key, a webhook signature, or a captcha + rate limit —
  // never with a session cookie. They MUST be exempt here: otherwise the
  // session check below 401s every external request (including CORS
  // preflight) before the route's own auth can run. The session-protected
  // management UIs for these features live under `/api/workspaces/...` and
  // are intentionally not listed.
  '/api/mcp/', // MCP Cloud — Bearer `mcp_cloud_keys`
  '/api/forms/', // public form submit/config — Turnstile captcha + rate limit + CORS
  '/api/conversation/', // Conversation API — Bearer conversation keys (ee)
  '/api/media/', // Media management API — Bearer CDN key (media:* scope)
]

// Refresh tokens 5 minutes before expiry to avoid edge-case failures
const REFRESH_BUFFER_SECONDS = 5 * 60

export default defineEventHandler(async (event) => {
  const path = getRequestPath(event)

  // Skip non-API routes and public paths
  if (!path.startsWith('/api') || PUBLIC_PATHS.some(p => path.startsWith(p)))
    return

  let sessionData
  try {
    sessionData = await getServerSession(event)
  }
  catch {
    // Cookie exists but is corrupted/undecryptable — treat as no session
    await clearServerSession(event)
  }

  if (!sessionData) {
    throw createError({
      statusCode: 401,
      message: errorMessage('auth.unauthorized'),
    })
  }

  const authProvider = useAuthProvider()
  const now = Math.floor(Date.now() / 1000)
  const isExpired = sessionData.expiresAt <= now + REFRESH_BUFFER_SECONDS

  // Auto-refresh expired tokens
  if (isExpired && sessionData.refreshToken) {
    const newTokens = await authProvider.refreshSession(sessionData.refreshToken)

    if (!newTokens) {
      // Refresh failed — clear session and force re-login
      await clearServerSession(event)
      throw createError({
        statusCode: 401,
        message: errorMessage('auth.session_expired'),
      })
    }

    // Persist refreshed tokens in encrypted cookie
    await setServerSession(event, {
      userId: sessionData.userId,
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
      expiresAt: newTokens.expiresAt,
    })

    // Use refreshed token for this request
    sessionData.accessToken = newTokens.accessToken
  }

  // Validate the (possibly refreshed) token
  const user = await authProvider.validateToken(sessionData.accessToken)

  if (!user) {
    await clearServerSession(event)
    throw createError({
      statusCode: 401,
      message: errorMessage('auth.session_invalid'),
    })
  }

  // Attach to event context for downstream handlers
  event.context.auth = {
    user,
    accessToken: sessionData.accessToken,
  }
})
