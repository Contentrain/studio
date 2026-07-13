/**
 * Remote MCP endpoint — the OAuth-authenticated, projectId-less surface.
 *
 * Canonical URL (what users enter in Claude/ChatGPT/Codex and what the
 * protected-resource metadata's `resource` field names):
 *
 *     ${siteUrl}/api/mcp/remote
 *
 * Project resolution moves from the URL path into the OAuth grant:
 * access token → grant → { user, workspace, project } → repo/installation
 * context. Everything after authentication is the same shared pipeline as
 * the API-key surface (server/utils/mcp-cloud-proxy.ts) — same loopback
 * server, same `x-cr-*` header contract, same combined monthly quota pool.
 *
 * Challenge discipline (drives client auth UX):
 * - Missing/invalid token → HTTP 401 + `WWW-Authenticate: Bearer
 *   resource_metadata=…` BEFORE anything else — this is the lazy-auth
 *   discovery trigger, and it must not depend on loopback readiness.
 * - Valid token, tool outside the granted scope → 403 insufficient_scope
 *   (step-up re-consent), except tools no scope can grant (lifecycle),
 *   which stay a plain 403.
 *
 * Managed pair only: the OAuth AS doesn't exist on the Supabase pair.
 */

import { getHeader, getRouterParam } from 'h3'
import { errorMessage } from '~~/server/utils/content-strings'
import { getInternalMcpUrl } from '~~/server/utils/mcp-cloud-runtime'
import { useDatabaseProvider } from '~~/server/utils/providers'
import { getWorkspacePlan, hasFeature } from '~~/server/utils/license'
import { runMcpCloudProxy } from '~~/server/utils/mcp-cloud-proxy'
import { verifyMcpAccessToken } from '~~/server/utils/oauth-server/tokens'
import { mcpInsufficientScope, mcpUnauthorized } from '~~/server/utils/oauth-server/challenge'
import { scopeForTool, toolsForScope } from '~~/server/utils/oauth-server/scopes'

/** Per-grant sliding-window rate limit (parity with the default key limit). */
const OAUTH_RATE_LIMIT_PER_MINUTE = 60

export default defineEventHandler(async (event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  // Authenticate FIRST — the bare 401 challenge is how clients discover the
  // authorization server, and it must work even while the loopback MCP
  // server is still booting.
  const grant = await verifyMcpAccessToken(getHeader(event, 'authorization'))
  if (!grant) {
    mcpUnauthorized(event)
  }

  const db = useDatabaseProvider()

  const project = await db.getProjectById(
    grant.projectId,
    'id, repo_full_name, content_root, workspace_id, cdn_enabled',
  )
  if (!project || project.workspace_id !== grant.workspaceId) {
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })
  }

  const workspace = await db.getWorkspaceById(
    grant.workspaceId,
    'id, github_installation_id, plan, overage_settings, owner_id',
  )
  if (!workspace?.github_installation_id) {
    throw createError({ statusCode: 400, message: errorMessage('github.installation_missing') })
  }

  const plan = getWorkspacePlan(workspace)
  if (!hasFeature(plan, 'api.mcp_cloud_oauth')) {
    // Billing condition, not a scope condition — a step-up challenge could
    // never fix it, so this stays a plain 403 with an actionable message.
    throw createError({ statusCode: 403, message: errorMessage('oauth.plan_required') })
  }

  const mcpUrl = getInternalMcpUrl()
  if (!mcpUrl) {
    throw createError({ statusCode: 503, message: errorMessage('mcp_cloud.server_unavailable') })
  }

  return runMcpCloudProxy(event, mcpUrl, getRouterParam(event, 'slug') ?? '', {
    projectId: grant.projectId,
    workspaceId: grant.workspaceId,
    plan,
    overageSettings: (workspace.overage_settings as Record<string, boolean> | null) ?? {},
    installationId: workspace.github_installation_id as number,
    repoFullName: project.repo_full_name as string,
    contentRoot: (project.content_root as string | null) ?? '',
    cdnEnabled: project.cdn_enabled === true,
    mediaOwnerId: (workspace.owner_id as string | null) ?? null,
    allowedTools: toolsForScope(grant.scope),
    rateLimitPerMinute: OAUTH_RATE_LIMIT_PER_MINUTE,
    rateLimitKey: `mcp-oauth:${grant.grantId}`,
    monthlyCallLimit: null,
    meter: { kind: 'grant', id: grant.grantId },
    onToolDenied: (deniedEvent, tool) => {
      const required = scopeForTool(tool)
      if (required) {
        mcpInsufficientScope(deniedEvent, required, grant.scope)
      }
      // Lifecycle/unknown tools: no scope grants them — a step-up
      // challenge would only loop the client through consent for nothing.
      throw createError({
        statusCode: 403,
        message: errorMessage('mcp_cloud.tool_not_allowed', { tool }),
      })
    },
  })
})
