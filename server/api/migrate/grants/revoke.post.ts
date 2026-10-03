/**
 * POST /api/migrate/grants/revoke
 *
 * Migrate asks, server to server, to withdraw an order's Studio grant (refund or
 * failed delivery). Body `{ token }`: a request signed with Migrate's key
 * (`MigrateRevokeRequest`, `@contentrain/types`), single-use by `jti`, keyed by
 * `order_id`. Not a user surface: no session. The subscription is cancelled in
 * Polar and the grant marked `revoked`; see `revokeMigrateGrant`. An order Studio
 * holds no grant for is a 404.
 */
import { validateMigrateRevokeRequest } from '@contentrain/types'
import { readMigrateS2sRequest } from '../../../utils/migrate-s2s-route'
import { revokeMigrateGrant } from '../../../utils/migrate-revoke'

export default defineEventHandler(async (event) => {
  const request = await readMigrateS2sRequest(event, 'revoke', validateMigrateRevokeRequest)
  const db = useDatabaseProvider()
  try {
    const grant = await db.getMigrateGrantByOrderId(request.order_id)
    if (!grant) throw createError({ statusCode: 404, message: errorMessage('migrate.grant_not_found') })
    return await revokeMigrateGrant(grant, request.reason)
  }
  catch (err) {
    // The jti is single-use; give it back only when Studio itself failed, so Migrate can retry the same request.
    const status = (err as { statusCode?: number }).statusCode
    if (status === undefined || status >= 500) await db.releaseMigrateS2sJti(request.jti)
    throw err
  }
})
