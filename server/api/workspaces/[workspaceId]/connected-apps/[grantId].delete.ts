/**
 * Revoke an OAuth grant. Kills the refresh-token family and deletes live
 * access tokens — the connected client's next refresh gets `invalid_grant`
 * and re-runs the auth flow cleanly.
 *
 * Owners/admins revoke any grant in the workspace; a member may revoke
 * their own connections only.
 */
import { getRouterParam } from 'h3'
import { requireAuth } from '~~/server/utils/auth'
import { errorMessage } from '~~/server/utils/content-strings'
import { useDatabaseProvider } from '~~/server/utils/providers'
import { getWorkspaceGrant, revokeGrant } from '~~/server/utils/oauth-server/store'

export default defineEventHandler(async (event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const grantId = getRouterParam(event, 'grantId')

  if (!workspaceId) {
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })
  }
  if (!grantId) {
    throw createError({ statusCode: 404, message: errorMessage('oauth.grant_not_found') })
  }

  const db = useDatabaseProvider()
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const grant = await getWorkspaceGrant(grantId, workspaceId)
  if (!grant) {
    throw createError({ statusCode: 404, message: errorMessage('oauth.grant_not_found') })
  }
  if (role === 'member' && grant.userId !== session.user.id) {
    throw createError({ statusCode: 403, message: errorMessage('oauth.revoke_forbidden') })
  }

  await revokeGrant(grantId, workspaceId)

  return { revoked: true }
})
