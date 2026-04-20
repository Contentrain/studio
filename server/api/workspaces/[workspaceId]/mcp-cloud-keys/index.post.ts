/**
 * Create an MCP Cloud API key.
 *
 * Auth: workspace owner or admin.
 * Gates: `api.mcp_cloud` feature + `api.mcp_keys` limit (per workspace).
 * Response: `{ key, ... }` — the plaintext `key` is returned exactly
 * once. Callers must persist it on their side; the server only stores
 * the SHA-256 hash.
 */

import { getRouterParam, readBody } from 'h3'
import { requireAuth } from '~~/server/utils/auth'
import { errorMessage } from '~~/server/utils/content-strings'
import { getPlanLimit, getWorkspacePlan, hasFeature } from '~~/server/utils/license'
import { generateMcpCloudKey } from '~~/server/utils/mcp-cloud-keys'
import { useDatabaseProvider } from '~~/server/utils/providers'

interface CreateKeyInput {
  projectId: string
  name: string
  allowedTools?: string[]
  rateLimitPerMinute?: number
  monthlyCallLimit?: number | null
}

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  if (!workspaceId) {
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })
  }

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const workspace = await db.getWorkspaceById(workspaceId, 'id, plan')
  if (!workspace) {
    throw createError({ statusCode: 404, message: errorMessage('workspace.not_found') })
  }

  const plan = getWorkspacePlan(workspace)
  if (!hasFeature(plan, 'api.mcp_cloud')) {
    throw createError({ statusCode: 403, message: errorMessage('mcp_cloud.upgrade') })
  }

  const body = await readBody<CreateKeyInput>(event)
  if (!body?.name?.trim()) {
    throw createError({ statusCode: 400, message: errorMessage('mcp_cloud.key_name_required') })
  }
  if (!body?.projectId) {
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })
  }

  const project = await db.getProjectById(body.projectId, 'id, workspace_id')
  if (!project || project.workspace_id !== workspaceId) {
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })
  }

  const keyLimit = getPlanLimit(plan, 'api.mcp_keys')
  const currentCount = await db.countActiveMcpCloudKeys(workspaceId)
  if (Number.isFinite(keyLimit) && currentCount >= keyLimit) {
    throw createError({ statusCode: 403, message: errorMessage('mcp_cloud.key_limit') })
  }

  const { key, keyHash, keyPrefix } = generateMcpCloudKey()

  const row = await db.createMcpCloudKey({
    workspaceId,
    projectId: body.projectId,
    name: body.name.trim(),
    keyHash,
    keyPrefix,
    allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools : [],
    rateLimitPerMinute: body.rateLimitPerMinute,
    monthlyCallLimit: body.monthlyCallLimit ?? null,
    createdBy: session.user.id,
  })

  return {
    id: row.id,
    key, // plaintext — shown to user exactly once
    keyPrefix: row.key_prefix,
    name: row.name,
    projectId: row.project_id,
    allowedTools: row.allowed_tools ?? [],
    rateLimitPerMinute: row.rate_limit_per_minute,
    monthlyCallLimit: row.monthly_call_limit,
    createdAt: row.created_at,
  }
})
