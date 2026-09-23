/**
 * Verify the claim token a paid Migrate order links to Studio with.
 *
 * Migrate signs with its Ed25519 private key; Studio holds only the public
 * key (`NUXT_MIGRATE_CLAIM_PUBLIC_KEY`, SPKI PEM), so nothing that can mint a
 * grant lives here. Checked: the signature (EdDSA only), issuer, audience,
 * expiry, a short lifetime, a `jti`, and the payload shape. Single use is
 * per order and enforced by the grant table, not by remembering tokens.
 */
import { errors as joseErrors, importSPKI, jwtVerify } from 'jose'
import {
  MIGRATE_STUDIO_CLAIM_AUDIENCE,
  MIGRATE_STUDIO_CLAIM_ISSUER,
  MIGRATE_STUDIO_CLAIM_MAX_TTL_SECONDS,
  isMigrateStudioClaim,
} from '../../shared/utils/migrate-claim'
import type { MigrateStudioClaim } from '../../shared/utils/migrate-claim'

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
  subject: string | null
}

let cachedKey: { pem: string, key: CryptoKey } | null = null

async function publicKey(pem: string): Promise<CryptoKey> {
  if (cachedKey?.pem === pem) return cachedKey.key
  const key = await importSPKI(pem, 'EdDSA')
  cachedKey = { pem, key }
  return key
}

export async function verifyMigrateClaim(
  token: string,
  publicKeyPem: string,
  options: { now?: Date } = {},
): Promise<VerifiedMigrateClaim> {
  let payload
  try {
    const key = await publicKey(publicKeyPem)
    ;({ payload } = await jwtVerify(token, key, {
      algorithms: ['EdDSA'],
      issuer: MIGRATE_STUDIO_CLAIM_ISSUER,
      audience: MIGRATE_STUDIO_CLAIM_AUDIENCE,
      requiredClaims: ['exp', 'iat', 'jti'],
      maxTokenAge: MIGRATE_STUDIO_CLAIM_MAX_TTL_SECONDS,
      ...(options.now ? { currentDate: options.now } : {}),
    }))
  }
  catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new MigrateClaimError('expired', 'Claim link expired')
    throw new MigrateClaimError('invalid', 'Claim token rejected')
  }
  // `maxTokenAge` bounds the age from `iat`; an `exp` set further out than
  // the contract allows is refused too, so a leaked token cannot live long.
  if ((payload.exp as number) - (payload.iat as number) > MIGRATE_STUDIO_CLAIM_MAX_TTL_SECONDS)
    throw new MigrateClaimError('invalid', 'Claim token lifetime too long')
  const { jti, sub } = payload
  if (!isMigrateStudioClaim(payload))
    throw new MigrateClaimError('invalid', 'Claim payload malformed')

  return {
    claim: payload,
    jti: jti as string,
    subject: typeof sub === 'string' ? sub : null,
  }
}
