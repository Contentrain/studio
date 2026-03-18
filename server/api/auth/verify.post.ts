export default defineEventHandler(async (event) => {
  const body = await readBody<{
    code?: string
    accessToken?: string
    refreshToken?: string
  }>(event)

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
