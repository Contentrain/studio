/**
 * MCP Cloud endpoint — hosted HTTP MCP for external AI agents (API-key
 * surface).
 *
 * Route: `/api/mcp/v1/{projectId}/{...}` (catch-all so the MCP streamable
 * transport can own `/mcp`, `/message`, etc. without Nitro fighting it).
 *
 * This route owns caller authentication + project resolution:
 *   1. Bearer auth — validate an active `mcp_cloud_keys` row.
 *   2. ProjectId match — key must be scoped to the route's project.
 *   3. Plan gate — `api.mcp_cloud` feature flag.
 * Everything downstream (rate limit, per-key tool allowlist, atomic quota,
 * metering, `x-cr-*` strip/inject, the proxy hop, brain invalidation and
 * auto-merge reconcile) is the shared pipeline in
 * server/utils/mcp-cloud-proxy.ts — one behavior contract with the OAuth
 * remote surface (/api/mcp/remote), pinned by the proxy integration tests.
 */

import { getHeader, getRouterParam } from 'h3'
import { errorMessage } from '~~/server/utils/content-strings'
import { validateMcpCloudKey } from '~~/server/utils/mcp-cloud-keys'
import { getInternalMcpUrl } from '~~/server/utils/mcp-cloud-runtime'
import { useDatabaseProvider } from '~~/server/utils/providers'
import { getWorkspacePlan, hasFeature } from '~~/server/utils/license'
import { runMcpCloudProxy } from '~~/server/utils/mcp-cloud-proxy'

export default defineEventHandler(async (event) => {
  const mcpUrl = getInternalMcpUrl()
  if (!mcpUrl) {
    throw createError({ statusCode: 503, message: errorMessage('mcp_cloud.server_unavailable') })
  }

  const authHeader = getHeader(event, 'authorization')
  const keyData = await validateMcpCloudKey(authHeader)

  const routeProjectId = getRouterParam(event, 'projectId')
  if (!routeProjectId || routeProjectId !== keyData.projectId) {
    throw createError({ statusCode: 403, message: errorMessage('mcp_cloud.key_project_mismatch') })
  }

  const db = useDatabaseProvider()

  const project = await db.getProjectById(
    keyData.projectId,
    'id, repo_full_name, content_root, workspace_id',
  )
  if (!project || project.workspace_id !== keyData.workspaceId) {
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })
  }

  const workspace = await db.getWorkspaceById(
    keyData.workspaceId,
    'id, github_installation_id, plan, overage_settings',
  )
  if (!workspace?.github_installation_id) {
    throw createError({ statusCode: 400, message: errorMessage('github.installation_missing') })
  }

  const plan = getWorkspacePlan(workspace)
  if (!hasFeature(plan, 'api.mcp_cloud')) {
    throw createError({ statusCode: 403, message: errorMessage('mcp_cloud.upgrade') })
  }

  return runMcpCloudProxy(event, mcpUrl, getRouterParam(event, 'slug') ?? '', {
    projectId: keyData.projectId,
    workspaceId: keyData.workspaceId,
    plan,
    overageSettings: (workspace.overage_settings as Record<string, boolean> | null) ?? {},
    installationId: workspace.github_installation_id as number,
    repoFullName: project.repo_full_name as string,
    contentRoot: (project.content_root as string | null) ?? '',
    allowedTools: keyData.allowedTools,
    rateLimitPerMinute: keyData.rateLimitPerMinute,
    rateLimitKey: `mcp-cloud:${keyData.keyId}`,
    monthlyCallLimit: keyData.monthlyCallLimit,
    meter: { kind: 'key', id: keyData.keyId },
  })
})
