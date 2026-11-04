/**
 * POST /api/migrate/grants/activate
 *
 * Migrate tells Studio, server to server, that it collected the bundle of an order
 * provisioned with `billing.collector: 'migrate'`, so Studio starts the prepaid Studio
 * year. Body `{ token }`: a request signed with Migrate's key (`MigrateGrantActivateRequest`,
 * `@contentrain/types`), single-use by `jti`, keyed by `order_id`. Not a user surface: no
 * session. See `activateMigrateGrant`. An order Studio holds no grant for is a 404.
 */
import { validateMigrateGrantActivateRequest } from '@contentrain/types'
import { readMigrateS2sRequest } from '../../../utils/migrate-s2s-route'
import { activateMigrateGrant } from '../../../utils/migrate-activate'

export default defineEventHandler(async (event) => {
  const request = await readMigrateS2sRequest(event, 'activate', validateMigrateGrantActivateRequest)
  try {
    return await activateMigrateGrant(request)
  }
  catch (err) {
    // The jti is single-use; give it back only when Studio itself failed, so Migrate can retry the same request.
    const status = (err as { statusCode?: number }).statusCode
    if (status === undefined || status >= 500) await useDatabaseProvider().releaseMigrateS2sJti(request.jti)
    throw err
  }
})
