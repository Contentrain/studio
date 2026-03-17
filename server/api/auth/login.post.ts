import { createSupabaseAuthProvider } from '~~/server/providers/supabase-auth'

const authProvider = createSupabaseAuthProvider()

export default defineEventHandler(async (event) => {
  const body = await readBody<{ provider: 'github' | 'google', redirectTo?: string }>(event)

  if (!body.provider || !['github', 'google'].includes(body.provider)) {
    throw createError({
      statusCode: 400,
      message: 'Invalid provider. Must be "github" or "google".',
    })
  }

  const result = await authProvider.getOAuthRedirectUrl(
    body.provider,
    body.redirectTo || '/auth/callback',
  )

  return result
})
