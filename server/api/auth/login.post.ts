export default defineEventHandler(async (event) => {
  // Rate limit: 10 login requests per minute per IP
  const ip = getHeader(event, 'x-forwarded-for') ?? 'unknown'
  const rateCheck = checkRateLimit(`auth-login:${ip}`, 10, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: 'Too many requests. Try again later.' })

  const body = await readBody<{ provider: 'github' | 'google', redirectTo?: string }>(event)

  if (!body.provider || !['github', 'google'].includes(body.provider)) {
    throw createError({
      statusCode: 400,
      message: 'Invalid provider. Must be "github" or "google".',
    })
  }

  // Generate OAuth state token for CSRF protection
  const state = await setAuthState(event)

  const authProvider = useAuthProvider()
  const result = await authProvider.getOAuthRedirectUrl(
    body.provider,
    body.redirectTo || '/auth/callback',
  )

  return { ...result, state }
})
