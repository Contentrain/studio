/**
 * POST /api/migrate/account-state
 *
 * Migrate asks, server to server, whether the GitHub account that will own a
 * delivery already has a Studio plan (W54), so it can price the Studio line
 * of the bundle. Body `{ token }`: a request signed with Migrate's key
 * (`MigrateAccountStateRequest`, `@contentrain/types`), single-use by `jti`.
 *
 * The answer never names an account, a workspace or an email: only the state,
 * the plan and the cents Migrate needs. Not a user surface: no session.
 */
import { validateMigrateAccountStateRequest, validateMigrateAccountStateResponse } from '@contentrain/types'
import { resolveMigrateAccountState } from '../../utils/migrate-account-state'
import { migrateClaimPublicKey } from '../../utils/migrate-grant'
import { MigrateS2sError, verifyMigrateS2sRequest } from '../../utils/migrate-s2s'

export default defineEventHandler(async (event) => {
  const publicKey = migrateClaimPublicKey()
  if (!publicKey) throw createError({ statusCode: 404, message: errorMessage('migrate.unavailable') })

  const body = await readBody<{ token?: unknown }>(event)
  if (typeof body?.token !== 'string' || body.token.length === 0 || body.token.length > 4096)
    throw createError({ statusCode: 400, message: errorMessage('migrate.s2s_invalid') })

  let request
  try {
    request = await verifyMigrateS2sRequest(
      body.token,
      publicKey,
      'account-state',
      (payload, now) => {
        const checked = validateMigrateAccountStateRequest(payload, { now })
        return checked.ok ? { ok: true, value: checked.request } : checked
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

  const response = await resolveMigrateAccountState(request.github_user_id, request.plan)
  // Fail closed on our own answer: Migrate prices from it.
  if (!validateMigrateAccountStateResponse(response, { requested: request.plan }).ok)
    throw createError({ statusCode: 500, message: errorMessage('migrate.s2s_invalid') })
  return response
})
