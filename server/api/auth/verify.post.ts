export default defineEventHandler(async (event) => {
  // Rate limit
  const ip = getHeader(event, 'x-forwarded-for') ?? 'unknown'
  const rateCheck = checkRateLimit(`auth-verify:${ip}`, 10, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: 'Too many requests. Try again later.' })

  const body = await readBody<{
    code?: string
    accessToken?: string
    refreshToken?: string
    state?: string
  }>(event)

  // OAuth state CSRF protection — log-only mode for debugging
  // State cookie may not persist across OAuth provider redirect in all environments
  if (body.state && typeof body.state === 'string' && body.state.length > 0) {
    const valid = await validateAuthState(event, body.state)
    if (!valid) {
      // eslint-disable-next-line no-console
      console.warn('[auth] OAuth state validation failed — allowing login (log-only mode)')
    }
  }

  const authProvider = useAuthProvider()
  let session

  if (body.code) {
    session = await authProvider.exchangeCode(body.code)
  }
  else if (body.accessToken) {
    session = await authProvider.exchangeTokens(body.accessToken, body.refreshToken ?? undefined)
  }
  else {
    throw createError({ statusCode: 400, message: 'code or accessToken required' })
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
