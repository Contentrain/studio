/**
 * POST /api/migrate/grants/status
 *
 * Migrate asks, server to server, where an order's Studio grant stands, so
 * its page can show the Studio card (W39). Body `{ token }`: a request signed
 * with Migrate's key (`MigrateGrantStatusRequest`, `@contentrain/types`),
 * single-use by `jti`, keyed by `order_id`. Not a user surface: no session.
 *
 * Answers only the state, what kind of Studio the order has (`kind`, `plan`, its end and whether the plan
 * has ended — `migrateGrantStatusDetail`) and whether Studio's GitHub App is installed for the
 * grant's workspace and, if so, the GitHub account it is installed on (`workspace_github_account`, so the delivery
 * defaults to it) — never a Studio workspace or email. An order Studio
 * holds no grant for is a 404.
 */
import { validateMigrateGrantStatusRequest, validateMigrateGrantStatusResponse } from '@contentrain/types'
import { migrateGrantGithubAccount, migrateGrantInstallation, migrateGrantStateOf, migrateGrantStatusDetail } from '../../../utils/migrate-grant-status'
import { readMigrateS2sRequest } from '../../../utils/migrate-s2s-route'

export default defineEventHandler(async (event) => {
  const request = await readMigrateS2sRequest(event, 'grant-status', validateMigrateGrantStatusRequest)

  const grant = await useDatabaseProvider().getMigrateGrantByOrderId(request.order_id)
  if (!grant) throw createError({ statusCode: 404, message: errorMessage('migrate.grant_not_found') })

  const state = migrateGrantStateOf(grant)
  const { workspace, installed } = await migrateGrantInstallation(grant)
  // An install only counts once the subscription ran (the contract refuses it earlier); a revoked grant keeps one made before.
  const live = state === 'redeemed' || state === 'revoked'
  const account = installed && live ? await migrateGrantGithubAccount(workspace) : null
  const response = { state, installed: installed && live, ...await migrateGrantStatusDetail(grant), ...(account ? { workspace_github_account: account } : {}) }
  // Fail closed on our own answer: Migrate shows it to a customer.
  if (!validateMigrateGrantStatusResponse(response).ok)
    throw createError({ statusCode: 500, message: errorMessage('migrate.s2s_invalid') })
  return response
})
