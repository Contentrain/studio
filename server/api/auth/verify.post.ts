export default defineEventHandler(async (event) => {
  // Rate limit
  const ip = getHeader(event, 'x-forwarded-for') ?? 'unknown'
  const rateCheck = checkRateLimit(`auth-verify:${ip}`, 10, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('auth.rate_limited') })

  const body = await readBody<{
    code?: string
    accessToken?: string
    refreshToken?: string
    state?: string
  }>(event)

  // OAuth state CSRF protection
  // Code flow (OAuth): state is required and validated
  // Token flow (magic link): state is optional (no redirect to hijack)
  if (body.code && body.state) {
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

  // Store tokens in encrypted httpOnly cookie — never exposed to client
  await setServerSession(event, {
    userId: session.user.id,
    accessToken: session.tokens.accessToken,
    refreshToken: session.tokens.refreshToken,
    expiresAt: session.tokens.expiresAt,
  })

  return { user: session.user }
})
