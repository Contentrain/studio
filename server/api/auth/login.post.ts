export default defineEventHandler(async (event) => {
  // Rate limit: 10 login requests per minute per IP
  const ip = getClientIp(event)
  const rateCheck = checkRateLimit(`auth-login:${ip}`, 10, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('auth.rate_limited') })

  const body = await readBody<{ provider: 'github' | 'google', redirectTo?: string }>(event)

  if (!body.provider || !['github', 'google'].includes(body.provider)) {
    throw createError({
      statusCode: 400,
      message: errorMessage('auth.invalid_provider'),
    })
  }

  const authProvider = useAuthProvider()
  const result = await authProvider.getOAuthRedirectUrl(
    body.provider,
    body.redirectTo || '/auth/callback',
  )

  // Store provider-generated state in encrypted cookie for validation on callback
  if (result.state) {
    await setAuthState(event, result.state)
  }

  return result
})
