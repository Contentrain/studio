/**
 * POST /api/migrate/claim
 *
 * Turn the claim link a paid Migrate order opens Studio with into a grant
 * on the signed-in account: "N days of Studio {plan} for {repo}". The token
 * is verified against Migrate's public key; the grant is recorded once per
 * order. Opening the same order's link again (new token, same account)
 * returns the same grant; another account gets 409.
 *
 * No trial starts here — that happens at the grant's checkout, on the
 * workspace the user picks.
 *
 * A claim that carries a comments export starts taking it onto the grant
 * (`captureClaimCommentsExport`) and answers without waiting for it: the
 * export is imported later, into the project, and a failure only means the
 * file upload.
 */
import { MigrateClaimError, verifyMigrateClaim } from '../../utils/migrate-claim'
import { captureClaimCommentsExport } from '../../utils/migrate-comments-export'
import { claimCommentsView, migrateClaimPublicKey, migrateGrantDestination, migrateGrantView } from '../../utils/migrate-grant'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)

  const publicKey = migrateClaimPublicKey()
  if (!publicKey) throw createError({ statusCode: 404, message: errorMessage('migrate.unavailable') })

  const body = await readBody<{ token?: unknown }>(event)
  if (typeof body?.token !== 'string' || body.token.length === 0 || body.token.length > 8192)
    throw createError({ statusCode: 400, message: errorMessage('migrate.claim_invalid') })

  const rate = await checkRateLimit(`migrate-claim:${session.user.id}`, 10, 60_000)
  if (!rate.allowed) throw createError({ statusCode: 429, message: errorMessage('auth.rate_limited') })

  let verified
  try {
    verified = await verifyMigrateClaim(body.token, publicKey)
  }
  catch (err) {
    if (err instanceof MigrateClaimError && err.reason === 'expired')
      throw createError({ statusCode: 410, message: errorMessage('migrate.claim_expired') })
    throw createError({ statusCode: 400, message: errorMessage('migrate.claim_invalid') })
  }

  const { claim, jti, warnings } = verified
  const { grant } = await useDatabaseProvider().claimMigrateGrant({
    orderId: claim.order_id,
    claimJti: jti,
    userId: session.user.id,
    plan: claim.plan,
    trialDays: claim.trial_days,
    repoOwner: claim.repo.owner,
    repoName: claim.repo.name,
    email: claim.email,
    // Signed by Migrate: the only host media import will fetch old-site files from.
    origin: claim.origin ?? null,
  })

  if (grant.user_id !== session.user.id)
    throw createError({ statusCode: 409, message: errorMessage('migrate.claim_taken') })
  // The order was bought as a bundle: its Studio year is on the order, there is no trial to claim.
  if (grant.kind === 'bundle')
    throw createError({ statusCode: 409, message: errorMessage('migrate.grant_bundle') })

  const existing = await useDatabaseProvider().getMigrateCommentsExportState(grant.id as string)
  // Not awaited: a slow or failing export never holds the claim up. It never throws.
  void captureClaimCommentsExport({ grantId: grant.id as string, pointer: claim.comments_export, warnings })

  return {
    grant: migrateGrantView(grant),
    destination: await migrateGrantDestination(session, grant),
    capabilities: claim.capabilities ?? [],
    planEvidence: claim.plan_evidence,
    comments: claimCommentsView(existing, claim.comments_export, warnings),
  }
})
