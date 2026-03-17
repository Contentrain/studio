import { createSupabaseAuthProvider } from '../providers/supabase-auth'

const authProvider = createSupabaseAuthProvider()

const PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/magic-link',
  '/api/auth/verify',
  '/api/health',
]

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // Skip non-API routes and public paths
  if (!path.startsWith('/api') || PUBLIC_PATHS.some(p => path.startsWith(p)))
    return

  const session = await authProvider.getSession(event)

  if (!session) {
    throw createError({
      statusCode: 401,
      message: 'Unauthorized',
    })
  }

  // Attach session to event context for downstream handlers
  event.context.auth = session
})
