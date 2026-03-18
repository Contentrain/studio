import type { H3Event } from 'h3'
import type { AuthUser } from '../providers/auth'

export interface RequestAuth {
  user: AuthUser
  accessToken: string
}

/**
 * Get the authenticated session from event context.
 * Throws 401 if not authenticated.
 *
 * Must be called after the auth middleware has run.
 */
export function requireAuth(event: H3Event): RequestAuth {
  const auth = event.context.auth as RequestAuth | undefined

  if (!auth) {
    throw createError({
      statusCode: 401,
      message: 'Unauthorized',
    })
  }

  return auth
}
