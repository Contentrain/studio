/**
 * List MCP Cloud API keys in a workspace.
 *
 * Auth: workspace member (any role).
 * Scope: workspace-wide; optional `projectId` query filter narrows results.
 * Response: array of key metadata (no plaintext — only prefix, limits,
 * usage timestamps). Plaintext is shown once at create time and never
 * stored.
 */

import { getQuery, getRouterParam } from 'h3'
import { requireAuth } from '~~/server/utils/auth'
import { errorMessage } from '~~/server/utils/content-strings'
import { useDatabaseProvider } from '~~/server/utils/providers'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  if (!workspaceId) {
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })
  }

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const query = getQuery(event)
  const projectId = typeof query.projectId === 'string' ? query.projectId : undefined

  const keys = await db.listMcpCloudKeys(workspaceId, projectId)
  return { keys }
})
