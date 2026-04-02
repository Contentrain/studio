export default defineEventHandler(async (event) => {
  // Rate limit: 5 magic link requests per minute per IP
  const ip = getClientIp(event)
  const rateCheck = await checkRateLimit(`magic-link:${ip}`, 5, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('auth.rate_limited') })

  const body = await readBody<{ email: string, redirectTo?: string }>(event)

  if (!body.email) {
    throw createError({
      statusCode: 400,
      message: errorMessage('auth.email_required'),
    })
  }

  const authProvider = useAuthProvider()
  await authProvider.sendMagicLink(
    body.email,
    body.redirectTo || '/auth/callback',
  )

  return { sent: true }
})
