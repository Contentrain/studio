export default defineEventHandler(async (event) => {
  // Rate limit: 5 magic link requests per minute per IP
  const ip = getHeader(event, 'x-forwarded-for') ?? 'unknown'
  const rateCheck = checkRateLimit(`magic-link:${ip}`, 5, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: 'Too many requests. Try again later.' })

  const body = await readBody<{ email: string, redirectTo?: string }>(event)

  if (!body.email) {
    throw createError({
      statusCode: 400,
      message: 'Email is required.',
    })
  }

  const authProvider = useAuthProvider()
  await authProvider.sendMagicLink(
    body.email,
    body.redirectTo || '/auth/callback',
  )

  return { sent: true }
})
