/**
 * The `state` Studio puts on the GitHub App install URL it hands Migrate.
 *
 * A short-lived HS256 JWS only Studio signs and verifies
 * (`NUXT_MIGRATE_INSTALL_STATE_KEY`). It names the grant and the workspace the
 * installation is for, so the GitHub setup callback needs no Studio session
 * to know where to bind. `jti` is single-use: the callback takes it, so a
 * replayed callback cannot rebind. A workspace-id `state` (the in-app install)
 * is a UUID and never has this shape.
 */
import { jwtVerify, SignJWT } from 'jose'

export const MIGRATE_INSTALL_STATE_ISSUER = 'contentrain-studio'
export const MIGRATE_INSTALL_STATE_AUDIENCE = 'studio-github-install'
export const MIGRATE_INSTALL_STATE_TTL_SECONDS = 600
const MIN_KEY_LENGTH = 32

export interface MigrateInstallState {
  jti: string
  /** Seconds since the epoch. */
  exp: number
  grantId: string
  workspaceId: string
  /** The Studio user who owns the grant. */
  userId: string
}

/** The signing key, or null when install links are off here (not set, or too short to trust). */
export function migrateInstallStateKey(): Uint8Array | null {
  const config = useRuntimeConfig() as unknown as { migrate?: { installStateKey?: string } }
  const raw = config.migrate?.installStateKey?.trim()
  if (!raw || raw.length < MIN_KEY_LENGTH) return null
  return new TextEncoder().encode(raw)
}

/** Three base64url segments: the shape of our `state`, never of a workspace id. */
export function looksLikeMigrateInstallState(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)
}

export async function signMigrateInstallState(
  input: Pick<MigrateInstallState, 'grantId' | 'workspaceId' | 'userId'>,
  key: Uint8Array,
  now: Date = new Date(),
): Promise<{ token: string, state: MigrateInstallState }> {
  const iat = Math.floor(now.getTime() / 1000)
  const state: MigrateInstallState = { ...input, jti: crypto.randomUUID(), exp: iat + MIGRATE_INSTALL_STATE_TTL_SECONDS }
  const token = await new SignJWT({ grantId: state.grantId, workspaceId: state.workspaceId, userId: state.userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(MIGRATE_INSTALL_STATE_ISSUER)
    .setAudience(MIGRATE_INSTALL_STATE_AUDIENCE)
    .setJti(state.jti)
    .setIssuedAt(iat)
    .setExpirationTime(state.exp)
    .sign(key)
  return { token, state }
}

/** The state a valid, unexpired token carries; null for anything else. */
export async function verifyMigrateInstallState(token: string, key: Uint8Array, now: Date = new Date()): Promise<MigrateInstallState | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: MIGRATE_INSTALL_STATE_ISSUER,
      audience: MIGRATE_INSTALL_STATE_AUDIENCE,
      requiredClaims: ['exp', 'jti'],
      currentDate: now,
    })
    const { grantId, workspaceId, userId, jti, exp } = payload as Record<string, unknown>
    if (typeof grantId !== 'string' || typeof workspaceId !== 'string' || typeof userId !== 'string'
      || typeof jti !== 'string' || typeof exp !== 'number') return null
    return { grantId, workspaceId, userId, jti, exp }
  }
  catch {
    return null
  }
}
