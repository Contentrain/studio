/**
 * The claim a paid Migrate order hands to Studio: "this order includes N
 * days of Studio {plan} for the site delivered to {repo}".
 *
 * Migrate signs it (EdDSA, its private key); Studio verifies it with
 * Migrate's public key (`server/utils/migrate-claim.ts`) and records one
 * grant per order. The shape is the contract between the two products.
 *
 * TEMPORARY LOCAL COPY — the canonical type is being added to
 * `@contentrain/types` (XS-1a). Once published, import it from there and
 * delete this file; the names and fields are kept identical on purpose.
 */

export const MIGRATE_STUDIO_CLAIM_ISSUER = 'contentrain-migrate'
export const MIGRATE_STUDIO_CLAIM_AUDIENCE = 'contentrain-studio'
/** A claim link is opened right after delivery; it does not need to live long. */
export const MIGRATE_STUDIO_CLAIM_MAX_TTL_SECONDS = 1800
/** Upper bound on the included trial, whatever the order says. */
export const MIGRATE_STUDIO_CLAIM_MAX_TRIAL_DAYS = 90

export interface MigrateStudioClaim {
  v: 1
  /** Migrate order id. One grant per order. */
  order_id: string
  /** Verified at Migrate. Shown to the user, not required to match their Studio login. */
  email: string
  /** The plan Migrate sized from what discovery found. */
  plan: 'starter' | 'pro'
  /** Length of the included trial, in days. */
  trial_days: number
  /** The repository the migrated site was delivered to. */
  repo: { provider: 'github', owner: string, name: string }
  /** What discovery found, for the claim screen. Optional. */
  capabilities?: Array<{ key: string, scale?: string | null }>
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Shape check only — the signature is the verifier's job. */
export function isMigrateStudioClaim(value: unknown): value is MigrateStudioClaim {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  const repo = c.repo as Record<string, unknown> | undefined
  return c.v === 1
    && isNonEmptyString(c.order_id)
    && isNonEmptyString(c.email)
    && (c.plan === 'starter' || c.plan === 'pro')
    && Number.isInteger(c.trial_days)
    && (c.trial_days as number) >= 1
    && (c.trial_days as number) <= MIGRATE_STUDIO_CLAIM_MAX_TRIAL_DAYS
    && !!repo && typeof repo === 'object'
    && repo.provider === 'github'
    && isNonEmptyString(repo.owner)
    && isNonEmptyString(repo.name)
    && (c.capabilities === undefined || Array.isArray(c.capabilities))
}
