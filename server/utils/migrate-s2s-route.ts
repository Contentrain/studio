/**
 * The shared front of Migrate's server-to-server routes (grant status,
 * install URL): the signing key must be configured, the body is `{ token }`,
 * and the token must verify (signature, window, contract shape, single-use
 * `jti`). Failures map to the same statuses as `account-state`: 404 when off,
 * 400 for a bad request, 410 expired, 409 replayed.
 */
import type { H3Event } from 'h3'
import { migrateClaimPublicKey } from './migrate-grant'
import { MigrateS2sError, verifyMigrateS2sRequest } from './migrate-s2s'

export async function readMigrateS2sRequest<T extends { jti: string, exp: number }>(
  event: H3Event,
  purpose: string,
  validate: (payload: unknown, options: { now: number }) => { ok: true, request: T } | { ok: false, errors: string[] },
): Promise<T> {
  const publicKey = migrateClaimPublicKey()
  if (!publicKey) throw createError({ statusCode: 404, message: errorMessage('migrate.unavailable') })

  const body = await readBody<{ token?: unknown }>(event)
  if (typeof body?.token !== 'string' || body.token.length === 0 || body.token.length > 4096)
    throw createError({ statusCode: 400, message: errorMessage('migrate.s2s_invalid') })

  try {
    return await verifyMigrateS2sRequest(
      body.token,
      publicKey,
      purpose,
      (payload, now) => {
        const checked = validate(payload, { now })
        return checked.ok ? { ok: true, value: checked.request } : checked
      },
      (jti, kind, expiresAt) => useDatabaseProvider().claimMigrateS2sJti(jti, kind, expiresAt),
    )
  }
  catch (err) {
    if (err instanceof MigrateS2sError) {
      if (err.reason === 'expired') throw createError({ statusCode: 410, message: errorMessage('migrate.claim_expired') })
      if (err.reason === 'replayed') throw createError({ statusCode: 409, message: errorMessage('migrate.s2s_replayed') })
    }
    throw createError({ statusCode: 400, message: errorMessage('migrate.s2s_invalid') })
  }
}
