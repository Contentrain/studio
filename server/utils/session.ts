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
  return config.sessionSecret
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
