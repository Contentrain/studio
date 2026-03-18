export default defineEventHandler(async (event) => {
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
