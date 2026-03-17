import { useSupabaseAdmin } from '~~/server/utils/supabase'

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    code?: string
    accessToken?: string
    refreshToken?: string
  }>(event)

  const admin = useSupabaseAdmin()
  let accessToken: string | null = null
  let refreshToken: string | null = null

  if (body.code) {
    const { data, error } = await admin.auth.exchangeCodeForSession(body.code)
    if (error || !data.session)
      throw createError({ statusCode: 401, message: 'Invalid code' })
    accessToken = data.session.access_token
    refreshToken = data.session.refresh_token
  }
  else if (body.accessToken) {
    accessToken = body.accessToken
    refreshToken = body.refreshToken ?? null
  }
  else {
    throw createError({ statusCode: 400, message: 'code or accessToken required' })
  }

  const { data: userData, error: userError } = await admin.auth.getUser(accessToken)
  if (userError || !userData.user)
    throw createError({ statusCode: 401, message: 'Invalid token' })

  setCookie(event, 'auth-session', JSON.stringify({ accessToken, refreshToken }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })

  const u = userData.user
  const provider = (u.app_metadata?.provider ?? null) as string | null

  return {
    user: {
      id: u.id,
      email: u.email ?? null,
      avatarUrl: u.user_metadata?.avatar_url ?? null,
      provider,
      providerAccountId: u.user_metadata?.provider_id ?? null,
    },
  }
})
