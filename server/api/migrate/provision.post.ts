/**
 * POST /api/migrate/provision
 *
 * Migrate asks, server to server, for the Studio side of a "Migrate with
 * Studio" bundle: the customer's Studio account and grant, and the one Polar
 * checkout that charges the whole quote. Body `{ token }`: a claim v2 signed
 * with Migrate's key (`MigrateStudioClaimV2`, `@contentrain/types`), single-use
 * by `jti`. Not a user surface: no session. See `provisionMigrateBundle`.
 */
import { validateMigrateStudioClaimV2 } from '@contentrain/types'
import { migrateClaimPublicKey } from '../../utils/migrate-grant'
import { provisionMigrateBundle } from '../../utils/migrate-provision'
import { MigrateS2sError, verifyMigrateS2sRequest } from '../../utils/migrate-s2s'

export default defineEventHandler(async (event) => {
  const publicKey = migrateClaimPublicKey()
  if (!publicKey) throw createError({ statusCode: 404, message: errorMessage('migrate.unavailable') })

  const body = await readBody<{ token?: unknown }>(event)
  if (typeof body?.token !== 'string' || body.token.length === 0 || body.token.length > 8192)
    throw createError({ statusCode: 400, message: errorMessage('migrate.s2s_invalid') })

  let claim
  try {
    claim = await verifyMigrateS2sRequest(
      body.token,
      publicKey,
      'provision',
      (payload, now) => {
        const checked = validateMigrateStudioClaimV2(payload, { now })
        return checked.ok ? { ok: true, value: checked.claim } : checked
      },
      (jti, purpose, expiresAt) => useDatabaseProvider().claimMigrateS2sJti(jti, purpose, expiresAt),
    )
  }
  catch (err) {
    if (err instanceof MigrateS2sError) {
      if (err.reason === 'expired') throw createError({ statusCode: 410, message: errorMessage('migrate.claim_expired') })
      if (err.reason === 'replayed') throw createError({ statusCode: 409, message: errorMessage('migrate.s2s_replayed') })
    }
    throw createError({ statusCode: 400, message: errorMessage('migrate.s2s_invalid') })
  }

  try {
    return await provisionMigrateBundle(claim)
  }
  catch (err) {
    // Only our own failures give the `jti` back, so Migrate's retry of the same request is not
    // refused as a replay. A refusal (4xx: quote changed, state unsupported, ...) is an answer,
    // and a failure after a checkout exists is persisted on the grant, so a retry finds it.
    const status = (err as { statusCode?: number }).statusCode
    if (!status || status >= 500) await useDatabaseProvider().releaseMigrateS2sJti(claim.jti).catch(() => {})
    throw err
  }
})
