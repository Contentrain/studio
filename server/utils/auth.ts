import type { H3Event } from 'h3'
import type { AuthSession } from '../providers/auth'

/**
 * Get the authenticated session from event context.
 * Throws 401 if not authenticated.
 */
export function requireAuth(event: H3Event): AuthSession {
  const session = event.context.auth as AuthSession | undefined

  if (!session) {
    throw createError({
      statusCode: 401,
      message: 'Unauthorized',
    })
  }

  return session
}
