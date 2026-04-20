/**
 * Revoke an MCP Cloud API key. Sets `revoked_at`; the key is no longer
 * accepted by the endpoint. Rows are kept for audit purposes.
 */

import { getRouterParam } from 'h3'
import { requireAuth } from '~~/server/utils/auth'
import { errorMessage } from '~~/server/utils/content-strings'
import { useDatabaseProvider } from '~~/server/utils/providers'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const keyId = getRouterParam(event, 'keyId')

  if (!workspaceId) {
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })
  }
  if (!keyId) {
    throw createError({ statusCode: 400, message: errorMessage('mcp_cloud.key_not_found') })
  }

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  await db.revokeMcpCloudKey(keyId, workspaceId)

  return { revoked: true }
})
