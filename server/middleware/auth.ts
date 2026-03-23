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
  '/api/auth/verify',
  '/api/health',
  '/api/webhooks/',
  '/api/cdn/',
]

// Refresh tokens 5 minutes before expiry to avoid edge-case failures
const REFRESH_BUFFER_SECONDS = 5 * 60

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

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
      message: 'Unauthorized',
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
        message: 'Session expired',
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
      message: 'Invalid session',
    })
  }

  // Attach to event context for downstream handlers
  event.context.auth = {
    user,
    accessToken: sessionData.accessToken,
  }
})
