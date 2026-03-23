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

  // Validate OAuth state (CSRF protection)
  if (body.state) {
    const valid = await validateAuthState(event, body.state)
    if (!valid)
      throw createError({ statusCode: 403, message: 'Invalid or expired auth state. Please try logging in again.' })
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
