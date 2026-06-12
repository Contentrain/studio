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
 *   4. Rate limit — per-key per-minute sliding window, every request.
 *   5. Per-key tool allowlist — a non-empty `allowed_tools` restricts
 *      which tools the key may call (read-only keys, CI keys).
 *   6. Atomic quota increment — `increment_mcp_cloud_usage_if_allowed` RPC,
 *      `tools/call` requests only. Protocol traffic (initialize, tools/list,
 *      SSE streams, session teardown) never consumes the monthly quota or
 *      writes meter events — users buy tool calls, not handshakes.
 *      Key-level monthly limit only tightens the plan's — it can never
 *      bypass the plan cap (security).
 *   7. Strip client-supplied `x-cr-*` headers so a caller cannot forge a
 *      project identity override, then attach Studio-signed ones.
 *   8. Forward the raw body explicitly (consumed it already for tool
 *      detection; h3's default body forwarding doesn't survive that).
 *   9. Proxy to the loopback MCP server with project identity headers.
 *  10. Brain-cache invalidation when the JSON-RPC request is a write tool.
 */

import { TOOL_ANNOTATIONS } from '@contentrain/mcp/tools/annotations'
import { getHeader, getRouterParam, proxyRequest, readRawBody, setResponseHeader } from 'h3'
import { errorMessage } from '~~/server/utils/content-strings'
import { invalidateBrainCache } from '~~/server/utils/brain-cache'
import { validateMcpCloudKey } from '~~/server/utils/mcp-cloud-keys'
import { getInternalMcpUrl } from '~~/server/utils/mcp-cloud-runtime'
import { useDatabaseProvider } from '~~/server/utils/providers'
import { checkRateLimit } from '~~/server/utils/rate-limit'
import { getPlanLimit, getWorkspacePlan, hasFeature } from '~~/server/utils/license'
import { getEffectiveLimit } from '~~/server/utils/overage'
import { reconcileMcpCloudAutoMerge } from '~~/server/utils/mcp-cloud-automerge'

/**
 * Merge/review lifecycle is Studio-owned: these tools are capability-gated
 * on the loopback server (no `localWorktree`) and must never trigger
 * brain invalidation or auto-merge reconciliation, even though MCP's
 * annotations mark some of them as writes.
 */
const STUDIO_OWNED_LIFECYCLE_TOOLS = new Set([
  'contentrain_merge',
  'contentrain_branch_list',
  'contentrain_branch_delete',
  'contentrain_submit',
])

/**
 * Tools whose effects can land on the content branch — derived from MCP's
 * own annotations (`readOnlyHint: false`) so a future MCP release that
 * opens e.g. `contentrain_bulk` to remote providers is covered without a
 * Studio change. Tools that are still localWorktree-gated merely cost a
 * harmless no-op reconcile if invoked.
 */
const WRITE_TOOL_NAMES = new Set(
  Object.entries(TOOL_ANNOTATIONS)
    .filter(([name, annotation]) => annotation.readOnlyHint !== true && !STUDIO_OWNED_LIFECYCLE_TOOLS.has(name))
    .map(([name]) => name),
)

/** Headers the proxy itself injects — any incoming value is discarded. */
const STUDIO_HEADERS = [
  'x-cr-installation-id',
  'x-cr-repo-owner',
  'x-cr-repo-name',
  'x-cr-content-root',
] as const

/**
 * Best-effort extraction of `tools/call` tool names from a JSON-RPC
 * request body. Handles legacy batch arrays defensively even though the
 * current MCP spec sends one message per POST.
 */
function extractToolCalls(rawBody: string | undefined): string[] {
  if (!rawBody) return []
  try {
    const parsed = JSON.parse(rawBody) as unknown
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    const names: string[] = []
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      const { method, params } = message as { method?: string, params?: { name?: string } }
      if (method === 'tools/call' && typeof params?.name === 'string') {
        names.push(params.name)
      }
    }
    return names
  }
  catch {
    return []
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
    const retryAfterSeconds = Math.max(1, Math.ceil(rateCheck.retryAfterMs / 1000))
    setResponseHeader(event, 'Retry-After', retryAfterSeconds)
    throw createError({
      statusCode: 429,
      message: errorMessage('chat.rate_limited', { seconds: retryAfterSeconds }),
    })
  }

  // Read the body once — we need it for tool detection (allowlist, quota,
  // write detection) and to forward explicitly to the loopback server
  // (h3's default forward drops the stream after the first consumption).
  const rawBody = event.method === 'POST' || event.method === 'PUT'
    ? await readRawBody(event, 'utf-8')
    : undefined
  const toolCalls = extractToolCalls(rawBody)

  // Per-key tool allowlist: empty = unrestricted, non-empty = whitelist.
  // Checked before the quota so denied calls never consume it.
  if (keyData.allowedTools.length > 0) {
    const denied = toolCalls.find(name => !keyData.allowedTools.includes(name))
    if (denied) {
      throw createError({
        statusCode: 403,
        message: errorMessage('mcp_cloud.tool_not_allowed', { tool: denied }),
      })
    }
  }

  // Only tool calls consume the monthly quota and produce meter events.
  // Protocol traffic (initialize, tools/list, SSE streams, DELETE) stays
  // free — it is still rate-limited above.
  if (toolCalls.length > 0) {
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

    // Best-effort meter write for overage billing. Fire-and-forget.
    recordMCPCallUsage({
      workspaceId: keyData.workspaceId,
      count: 1,
      keyId: keyData.keyId,
      month,
    }).catch(() => {})
  }

  const shouldInvalidateBrain = toolCalls.some(name => WRITE_TOOL_NAMES.has(name))

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

    // MCP's remote write path always reports `pending-review` and delegates
    // the merge to Studio. Land those branches when the project's effective
    // workflow is auto-merge (plan + config aware), matching the native
    // write paths. Fire-and-forget — it can never affect the response the
    // external agent already received.
    void reconcileMcpCloudAutoMerge({
      workspaceId: keyData.workspaceId,
      projectId: keyData.projectId,
      installationId: workspace.github_installation_id as number,
      repoFullName: project.repo_full_name as string,
      contentRoot: (project.content_root as string | null) ?? '',
      plan,
    }).catch(() => {})
  }

  return response
})
