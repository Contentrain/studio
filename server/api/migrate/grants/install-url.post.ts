/**
 * POST /api/migrate/grants/install-url
 *
 * Migrate asks, server to server, for the GitHub App install address the
 * customer opens while their move runs (W39). Body `{ token }`: a request
 * signed with Migrate's key (`MigrateInstallUrlRequest`), single-use by
 * `jti`, keyed by `order_id`.
 *
 * Offered only once the grant is redeemed (the subscription runs: a project
 * could not be opened before, 402) and Studio's App is not yet installed on
 * the grant's workspace. The address carries a Studio-signed `state` naming
 * the grant and workspace, and no repository: the delivery repo does not
 * exist during the move. GitHub returns the customer to the setup callback,
 * which binds the installation and signs them in.
 */
import { validateMigrateInstallUrlRequest, validateMigrateInstallUrlResponse } from '@contentrain/types'
import { migrateGrantInstallation, migrateGrantStateOf } from '../../../utils/migrate-grant-status'
import { migrateInstallStateKey, signMigrateInstallState } from '../../../utils/migrate-install-state'
import { readMigrateS2sRequest } from '../../../utils/migrate-s2s-route'

export default defineEventHandler(async (event) => {
  const key = migrateInstallStateKey()
  if (!key) throw createError({ statusCode: 404, message: errorMessage('migrate.unavailable') })

  const request = await readMigrateS2sRequest(event, 'install-url', validateMigrateInstallUrlRequest)

  const grant = await useDatabaseProvider().getMigrateGrantByOrderId(request.order_id)
  if (!grant) throw createError({ statusCode: 404, message: errorMessage('migrate.grant_not_found') })
  if (migrateGrantStateOf(grant) !== 'redeemed' || !grant.workspace_id)
    throw createError({ statusCode: 409, message: errorMessage('migrate.grant_not_ready') })

  const { installed } = await migrateGrantInstallation(grant)
  if (installed) throw createError({ statusCode: 409, message: errorMessage('migrate.install_already') })

  const { token, state } = await signMigrateInstallState({
    grantId: grant.id as string,
    workspaceId: grant.workspace_id as string,
    userId: grant.user_id as string,
  }, key)

  const slug = (useRuntimeConfig().public.githubAppSlug as string | undefined) || 'contentrain-studio'
  const response = { url: `https://github.com/apps/${slug}/installations/new?state=${token}`, expires_at: state.exp }
  if (!validateMigrateInstallUrlResponse(response).ok)
    throw createError({ statusCode: 500, message: errorMessage('migrate.s2s_invalid') })
  return response
})
