import type { H3Event } from 'h3'

/**
 * Provider-agnostic server session.
 * Stored in an AES-256 encrypted httpOnly cookie via h3 useSession().
 * No provider tokens are ever exposed to the client.
 */
export interface ServerSessionData {
  userId: string
  accessToken: string
  refreshToken: string | null
  expiresAt: number // Unix timestamp in seconds
}

const SESSION_NAME = 'contentrain-session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 7 // 7 days

function getSessionPassword(): string {
  const config = useRuntimeConfig()
  const secret = config.sessionSecret
  if (!secret || secret.length < 32) {
    // eslint-disable-next-line no-console
    console.error('[session] NUXT_SESSION_SECRET is missing or too short (< 32 chars). Sessions will be insecure.')
  }
  return secret || 'insecure-fallback-change-me-in-production-00'
}

export async function getServerSession(event: H3Event): Promise<ServerSessionData | null> {
  const session = await useSession<ServerSessionData>(event, {
    password: getSessionPassword(),
    name: SESSION_NAME,
  })

  if (!session.data?.userId)
    return null

  return session.data
}

export async function setServerSession(event: H3Event, data: ServerSessionData): Promise<void> {
  const session = await useSession<ServerSessionData>(event, {
    password: getSessionPassword(),
    name: SESSION_NAME,
    maxAge: SESSION_MAX_AGE,
  })

  await session.update(data)
}

export async function clearServerSession(event: H3Event): Promise<void> {
  const session = await useSession<ServerSessionData>(event, {
    password: getSessionPassword(),
    name: SESSION_NAME,
  })

  await session.clear()
}

// ─── OAuth State (CSRF Protection) ───

const AUTH_STATE_NAME = 'contentrain-auth-state'
const AUTH_STATE_MAX_AGE = 60 * 10 // 10 minutes

interface AuthStateData {
  state: string
  createdAt: number
}

/** Generate and store a random state token for OAuth CSRF protection. */
export async function setAuthState(event: H3Event): Promise<string> {
  const { randomBytes } = await import('node:crypto')
  const state = randomBytes(32).toString('hex')

  const session = await useSession<AuthStateData>(event, {
    password: getSessionPassword(),
    name: AUTH_STATE_NAME,
    maxAge: AUTH_STATE_MAX_AGE,
  })

  await session.update({ state, createdAt: Date.now() })
  return state
}

/** Validate that the provided state matches the stored one. Clears after check. */
export async function validateAuthState(event: H3Event, state: string): Promise<boolean> {
  const session = await useSession<AuthStateData>(event, {
    password: getSessionPassword(),
    name: AUTH_STATE_NAME,
  })

  const stored = session.data?.state
  await session.clear() // One-time use

  if (!stored || stored !== state) return false

  // Check expiry (10 min max)
  const age = Date.now() - (session.data?.createdAt ?? 0)
  if (age > AUTH_STATE_MAX_AGE * 1000) return false

  return true
}
