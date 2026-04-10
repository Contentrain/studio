/**
 * POST /api/auth/refresh
 *
 * Exchanges a refresh token for a new access + refresh token pair.
 * Primary consumer: CLI tools that manage tokens outside the browser session.
 *
 * Web clients don't call this directly — the auth middleware auto-refreshes
 * tokens stored in the encrypted httpOnly cookie.
 */
export default defineEventHandler(async (event) => {
  // Rate limit: 10 refresh requests per minute per IP
  const ip = getClientIp(event)
  const rateCheck = await checkRateLimit(`auth-refresh:${ip}`, 10, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('auth.rate_limited') })

  const body = await readBody<{ refreshToken?: string }>(event)

  if (!body.refreshToken) {
    throw createError({
      statusCode: 400,
      message: 'refreshToken is required',
    })
  }

  const authProvider = useAuthProvider()
  const newTokens = await authProvider.refreshSession(body.refreshToken)

  if (!newTokens) {
    throw createError({
      statusCode: 401,
      message: errorMessage('auth.session_expired'),
    })
  }

  return {
    accessToken: newTokens.accessToken,
    refreshToken: newTokens.refreshToken,
    expiresAt: newTokens.expiresAt,
  }
})
