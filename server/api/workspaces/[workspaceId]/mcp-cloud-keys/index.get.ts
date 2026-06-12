/**
 * List MCP Cloud API keys in a workspace.
 *
 * Auth: workspace member (any role).
 * Scope: workspace-wide; optional `projectId` query filter narrows results.
 * Response: array of key metadata (no plaintext — only prefix, limits,
 * usage timestamps, current-month call count). Plaintext is shown once at
 * create time and never stored.
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

  // Attach the current month's call count per key so the panel can show
  // usage without a second round trip. Best-effort: a usage read failure
  // must not break key management.
  const month = new Date().toISOString().slice(0, 7)
  const usageByKey = new Map<string, number>()
  try {
    const usage = await db.getMcpCloudKeyUsage(keys.map(k => k.id as string), month)
    for (const row of usage) {
      usageByKey.set(row.mcp_key_id as string, (row.call_count as number | null) ?? 0)
    }
  }
  catch { /* usage column degrades to 0 */ }

  return {
    keys: keys.map(key => ({
      ...key,
      calls_this_month: usageByKey.get(key.id as string) ?? 0,
    })),
  }
})
