/**
 * POST /api/auth/verify
 *
 * Exchanges an OAuth code (or magic link tokens) for an authenticated session.
 *
 * Two modes:
 *   1. Web (default): stores tokens in encrypted httpOnly cookie, returns { user }.
 *   2. CLI (source: 'cli'): returns { user, tokens } — no cookie is set.
 *      The CLI stores tokens locally and uses /api/auth/refresh when they expire.
 */
export default defineEventHandler(async (event) => {
  // Rate limit
  const ip = getHeader(event, 'x-forwarded-for') ?? 'unknown'
  const rateCheck = await checkRateLimit(`auth-verify:${ip}`, 10, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('auth.rate_limited') })

  const body = await readBody<{
    code?: string
    accessToken?: string
    refreshToken?: string
    state?: string
    source?: 'cli'
  }>(event)

  const isCli = body.source === 'cli'

  // OAuth state CSRF protection
  // Code flow (OAuth): state is REQUIRED and validated (web only — CLI manages its own state)
  // Token flow (magic link): state is optional (no redirect to hijack)
  if (body.code && !isCli) {
    if (!body.state) {
      throw createError({ statusCode: 403, message: errorMessage('auth.invalid_state') })
    }
    const valid = await validateAuthState(event, body.state)
    if (!valid)
      throw createError({ statusCode: 403, message: errorMessage('auth.invalid_state') })
  }

  const authProvider = useAuthProvider()
  let session

  if (body.code) {
    session = await authProvider.exchangeCode(body.code, body.state)
  }
  else if (body.accessToken) {
    // Magic link / implicit flow — no state required (email is the auth factor)
    session = await authProvider.exchangeTokens(body.accessToken, body.refreshToken ?? undefined)
  }
  else {
    throw createError({ statusCode: 400, message: errorMessage('auth.code_or_token_required') })
  }

  if (isCli) {
    // CLI: return tokens directly — no cookie
    return {
      user: session.user,
      tokens: {
        accessToken: session.tokens.accessToken,
        refreshToken: session.tokens.refreshToken,
        expiresAt: session.tokens.expiresAt,
      },
    }
  }

  // Web: store tokens in encrypted httpOnly cookie — never exposed to client
  await setServerSession(event, {
    userId: session.user.id,
    accessToken: session.tokens.accessToken,
    refreshToken: session.tokens.refreshToken,
    expiresAt: session.tokens.expiresAt,
  })

  return { user: session.user }
})
