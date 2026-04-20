/**
 * MCP Cloud endpoint — hosted HTTP MCP for external AI agents.
 *
 * Route: `/api/mcp/v1/{projectId}/{...}` (catch-all so the MCP streamable
 * transport can own `/mcp`, `/message`, etc. without Nitro fighting it).
 *
 * Responsibilities (gate kept in this route, never inside MCP):
 *   1. Bearer auth — validate an active `mcp_cloud_keys` row.
 *   2. ProjectId match — key must be scoped to the route's project.
 *   3. Plan gate — `api.mcp_cloud` feature flag.
 *   4. Rate limit — per-key per-minute sliding window.
 *   5. Atomic quota increment — `increment_mcp_cloud_usage_if_allowed` RPC.
 *      Key-level monthly limit only tightens the plan's — it can never
 *      bypass the plan cap (security).
 *   6. Strip client-supplied `x-cr-*` headers so a caller cannot forge a
 *      project identity override, then attach Studio-signed ones.
 *   7. Forward the raw body explicitly (consumed it already for tool
 *      detection; h3's default body forwarding doesn't survive that).
 *   8. Proxy to the loopback MCP server with project identity headers.
 *   9. Brain-cache invalidation when the JSON-RPC request is a write tool.
 */

import { getHeader, getRouterParam, proxyRequest, readRawBody } from 'h3'
import { errorMessage } from '~~/server/utils/content-strings'
import { invalidateBrainCache } from '~~/server/utils/brain-cache'
import { validateMcpCloudKey } from '~~/server/utils/mcp-cloud-keys'
import { getInternalMcpUrl } from '~~/server/utils/mcp-cloud-runtime'
import { useDatabaseProvider } from '~~/server/utils/providers'
import { checkRateLimit } from '~~/server/utils/rate-limit'
import { getPlanLimit, getWorkspacePlan, hasFeature } from '~~/server/utils/license'
import { getEffectiveLimit } from '~~/server/utils/overage'

const WRITE_TOOL_NAMES = new Set([
  'contentrain_content_save',
  'contentrain_content_delete',
  'contentrain_model_save',
  'contentrain_model_delete',
])

/** Headers the proxy itself injects — any incoming value is discarded. */
const STUDIO_HEADERS = [
  'x-cr-installation-id',
  'x-cr-repo-owner',
  'x-cr-repo-name',
  'x-cr-content-root',
] as const

/** Best-effort detection of write tool calls in a JSON-RPC request body. */
function isWriteToolCall(rawBody: string | undefined): boolean {
  if (!rawBody) return false
  try {
    const parsed = JSON.parse(rawBody) as {
      method?: string
      params?: { name?: string }
    }
    if (parsed.method !== 'tools/call') return false
    const name = parsed.params?.name
    return typeof name === 'string' && WRITE_TOOL_NAMES.has(name)
  }
  catch {
    return false
  }
}

/**
 * Combine a per-key monthly cap with the workspace plan's cap — whichever
 * is stricter wins. Null means "no cap enforced by this layer"; the RPC
 * treats null as unlimited. The key cap can only TIGHTEN the plan cap,
 * never exceed it — a starter key with `monthly_call_limit: 100000`
 * must not unlock 100K calls/month.
 */
function resolveEffectiveMonthlyLimit(
  planLimit: number,
  keyLimit: number | null,
): number | null {
  const finitePlan = Number.isFinite(planLimit) ? planLimit : null
  if (finitePlan != null && keyLimit != null) return Math.min(finitePlan, keyLimit)
  if (finitePlan != null) return finitePlan
  return keyLimit
}

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
  const overageSettings = (workspace.overage_settings as Record<string, boolean> | null) ?? {}
  if (!hasFeature(plan, 'api.mcp_cloud')) {
    throw createError({ statusCode: 403, message: errorMessage('mcp_cloud.upgrade') })
  }

  const rateCheck = await checkRateLimit(
    `mcp-cloud:${keyData.keyId}`,
    keyData.rateLimitPerMinute,
    60_000,
  )
  if (!rateCheck.allowed) {
    throw createError({
      statusCode: 429,
      message: errorMessage('chat.rate_limited', {
        seconds: Math.ceil(rateCheck.retryAfterMs / 1000),
      }),
    })
  }

  const planLimit = getPlanLimit(plan, 'api.mcp_calls_per_month')
  const softenedPlanLimit = getEffectiveLimit(planLimit, 'api.mcp_calls_per_month', overageSettings)
  const effectiveLimit = resolveEffectiveMonthlyLimit(
    softenedPlanLimit,
    keyData.monthlyCallLimit,
  )

  const month = new Date().toISOString().slice(0, 7)
  const quota = await db.incrementMcpCloudUsageIfAllowed({
    workspaceId: keyData.workspaceId,
    keyId: keyData.keyId,
    month,
    limit: effectiveLimit,
  })
  if (!quota.allowed) {
    throw createError({
      statusCode: 429,
      message: errorMessage('mcp_cloud.monthly_limit', {
        limit: effectiveLimit ?? 'unlimited',
      }),
    })
  }

  // Read the body once — we need it both for write-tool detection and to
  // forward explicitly to the loopback server (h3's default forward drops
  // the stream after the first consumption).
  const rawBody = event.method === 'POST' || event.method === 'PUT'
    ? await readRawBody(event, 'utf-8')
    : undefined
  const shouldInvalidateBrain = isWriteToolCall(rawBody)

  const [owner, repoName] = (project.repo_full_name as string).split('/')
  if (!owner || !repoName) {
    throw createError({ statusCode: 400, message: errorMessage('github.repo_required') })
  }

  // Strip any client-supplied `x-cr-*` headers — the proxy is the only
  // source of truth for project identity. Without this, a malicious
  // caller could include an installation id of another workspace and
  // have the resolver build a provider against someone else's repo.
  const reqHeaders = event.node.req.headers as Record<string, string | string[] | undefined>
  for (const name of STUDIO_HEADERS) {
    reqHeaders[name] = undefined
  }

  const slug = getRouterParam(event, 'slug') ?? ''
  const target = slug.length > 0 ? `${mcpUrl}/${slug}` : mcpUrl

  const response = await proxyRequest(event, target, {
    headers: {
      'x-cr-installation-id': String(workspace.github_installation_id),
      'x-cr-repo-owner': owner,
      'x-cr-repo-name': repoName,
      'x-cr-content-root': (project.content_root as string | null) ?? '',
    },
    fetchOptions: {
      method: event.method,
      body: rawBody,
    },
  })

  if (shouldInvalidateBrain) {
    invalidateBrainCache(keyData.projectId)
  }

  return response
})
