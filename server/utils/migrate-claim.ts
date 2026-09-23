/**
 * Verify the claim token a paid Migrate order links to Studio with.
 *
 * Migrate signs with its Ed25519 private key; Studio holds only the public
 * key (`NUXT_MIGRATE_CLAIM_PUBLIC_KEY`, SPKI PEM), so nothing that can mint a
 * grant lives here. Checked: the signature (EdDSA only), issuer, audience,
 * expiry, a short lifetime, a `jti`, and the payload against the shared
 * contract (`validateMigrateStudioClaim`, `@contentrain/types`). Single use
 * is per order and enforced by the grant table, not by remembering tokens.
 */
import { errors as joseErrors, importSPKI, jwtVerify } from 'jose'
import {
  MIGRATE_STUDIO_CLAIM_ALG,
  MIGRATE_STUDIO_CLAIM_AUDIENCE,
  MIGRATE_STUDIO_CLAIM_CLOCK_SKEW_SECONDS,
  MIGRATE_STUDIO_CLAIM_ISSUER,
  MIGRATE_STUDIO_CLAIM_MAX_TTL_SECONDS,
  validateMigrateStudioClaim,
} from '@contentrain/types'
import type { MigrateStudioClaim } from '@contentrain/types'

export type MigrateClaimFailure = 'expired' | 'invalid'

export class MigrateClaimError extends Error {
  constructor(readonly reason: MigrateClaimFailure, message: string) {
    super(message)
  }
}

export interface VerifiedMigrateClaim {
  claim: MigrateStudioClaim
  jti: string
  /** Migrate's user id (`sub`), kept for support look-ups only. */
  subject: string
}

let cachedKey: { pem: string, key: CryptoKey } | null = null

async function publicKey(pem: string): Promise<CryptoKey> {
  if (cachedKey?.pem === pem) return cachedKey.key
  const key = await importSPKI(pem, MIGRATE_STUDIO_CLAIM_ALG)
  cachedKey = { pem, key }
  return key
}

export async function verifyMigrateClaim(
  token: string,
  publicKeyPem: string,
  options: { now?: Date } = {},
): Promise<VerifiedMigrateClaim> {
  const now = options.now ?? new Date()
  let payload
  try {
    const key = await publicKey(publicKeyPem)
    ;({ payload } = await jwtVerify(token, key, {
      algorithms: [MIGRATE_STUDIO_CLAIM_ALG],
      issuer: MIGRATE_STUDIO_CLAIM_ISSUER,
      audience: MIGRATE_STUDIO_CLAIM_AUDIENCE,
      requiredClaims: ['exp', 'iat', 'jti', 'sub'],
      maxTokenAge: MIGRATE_STUDIO_CLAIM_MAX_TTL_SECONDS,
      clockTolerance: MIGRATE_STUDIO_CLAIM_CLOCK_SKEW_SECONDS,
      currentDate: now,
    }))
  }
  catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new MigrateClaimError('expired', 'Claim link expired')
    throw new MigrateClaimError('invalid', 'Claim token rejected')
  }
  // The signature is good; the payload must also match the contract,
  // including an `exp` no further out than the contract allows.
  const result = validateMigrateStudioClaim(payload, { now: Math.floor(now.getTime() / 1000) })
  if (!result.ok) {
    if (result.errors.includes('exp: expired')) throw new MigrateClaimError('expired', 'Claim link expired')
    throw new MigrateClaimError('invalid', `Claim payload rejected: ${result.errors.join('; ')}`)
  }

  return { claim: result.claim, jti: result.claim.jti, subject: result.claim.sub }
}
