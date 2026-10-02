/**
 * Verify a server-to-server request Migrate signs for Studio (account-state,
 * and the provision/status/revoke calls that follow it).
 *
 * Same key and rules as the claim link: Ed25519 (`NUXT_MIGRATE_CLAIM_PUBLIC_KEY`),
 * EdDSA only, issuer/audience pinned, a lifetime no longer than the contract
 * allows. The signed payload is the request itself, so what Migrate asked
 * cannot be altered in transit. `jti` is single-use: it is recorded (migration
 * 042) per `purpose` and a repeat is refused.
 */
import { errors as joseErrors, importSPKI, jwtVerify } from 'jose'
import {
  MIGRATE_STUDIO_CLAIM_ALG,
  MIGRATE_STUDIO_CLAIM_AUDIENCE,
  MIGRATE_STUDIO_CLAIM_CLOCK_SKEW_SECONDS,
  MIGRATE_STUDIO_CLAIM_ISSUER,
  MIGRATE_STUDIO_CLAIM_MAX_TTL_SECONDS,
} from '@contentrain/types'

export type MigrateS2sFailure = 'expired' | 'invalid' | 'replayed'

export class MigrateS2sError extends Error {
  constructor(readonly reason: MigrateS2sFailure, message: string) {
    super(message)
  }
}

let cachedKey: { pem: string, key: CryptoKey } | null = null

async function publicKey(pem: string): Promise<CryptoKey> {
  if (cachedKey?.pem === pem) return cachedKey.key
  const key = await importSPKI(pem, MIGRATE_STUDIO_CLAIM_ALG)
  cachedKey = { pem, key }
  return key
}

/**
 * Check signature and window, then hand the payload to `validate` (the shared
 * contract's validator for this request), then take the `jti`. The `jti` is
 * taken last so a request that is wrong anyway does not burn it.
 */
export async function verifyMigrateS2sRequest<T extends { jti: string, exp: number }>(
  token: string,
  publicKeyPem: string,
  purpose: string,
  validate: (payload: unknown, now: number) => { ok: true, value: T } | { ok: false, errors: string[] },
  claimJti: (jti: string, purpose: string, expiresAt: Date) => Promise<boolean>,
  options: { now?: Date } = {},
): Promise<T> {
  const now = options.now ?? new Date()
  let payload
  try {
    ;({ payload } = await jwtVerify(token, await publicKey(publicKeyPem), {
      algorithms: [MIGRATE_STUDIO_CLAIM_ALG],
      issuer: MIGRATE_STUDIO_CLAIM_ISSUER,
      audience: MIGRATE_STUDIO_CLAIM_AUDIENCE,
      requiredClaims: ['exp', 'iat', 'jti'],
      maxTokenAge: MIGRATE_STUDIO_CLAIM_MAX_TTL_SECONDS,
      clockTolerance: MIGRATE_STUDIO_CLAIM_CLOCK_SKEW_SECONDS,
      currentDate: now,
    }))
  }
  catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new MigrateS2sError('expired', 'Request expired')
    throw new MigrateS2sError('invalid', 'Request token rejected')
  }

  const result = validate(payload, Math.floor(now.getTime() / 1000))
  if (!result.ok) {
    if (result.errors.includes('exp: expired')) throw new MigrateS2sError('expired', 'Request expired')
    throw new MigrateS2sError('invalid', `Request payload rejected: ${result.errors.join('; ')}`)
  }

  // Remembered until the token could no longer verify (expiry plus skew).
  const keepUntil = new Date((result.value.exp + MIGRATE_STUDIO_CLAIM_CLOCK_SKEW_SECONDS) * 1000)
  if (!(await claimJti(result.value.jti, purpose, keepUntil)))
    throw new MigrateS2sError('replayed', 'Request already used')
  return result.value
}
