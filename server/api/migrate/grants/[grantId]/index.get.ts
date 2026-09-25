/**
 * GET /api/migrate/grants/:grantId
 *
 * A grant the caller owns — for the claim screen when it is reopened
 * without a token (e.g. back from an abandoned checkout), and the way to
 * the delivered site once the grant is tied to a workspace.
 */
import { migrateClaimPublicKey, migrateGrantDestination, migrateGrantView } from '../../../../utils/migrate-grant'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  if (!migrateClaimPublicKey())
    throw createError({ statusCode: 404, message: errorMessage('migrate.unavailable') })

  const grantId = getRouterParam(event, 'grantId') ?? ''
  const grant = grantId ? await useDatabaseProvider().getMigrateGrantForUser(grantId, session.user.id) : null
  if (!grant) throw createError({ statusCode: 404, message: errorMessage('migrate.grant_not_found') })

  return { grant: migrateGrantView(grant), destination: await migrateGrantDestination(session, grant), capabilities: [], planEvidence: [] }
})
