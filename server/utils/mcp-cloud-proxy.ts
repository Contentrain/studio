/**
 * Shared MCP Cloud proxy pipeline.
 *
 * Two entry routes feed it: the API-key surface (/api/mcp/v1/{projectId})
 * and the OAuth remote surface (/api/mcp/remote). They differ ONLY in how
 * the caller is authenticated and how the project is resolved — everything
 * downstream (rate limit, tool allowlist, combined monthly quota, metering,
 * x-cr-* header injection, the proxy hop, brain invalidation, auto-merge
 * reconcile) is identity-agnostic and lives here as `runMcpCloudProxy`.
 *
 * Behavior contract is pinned by tests/integration/mcp-cloud-proxy
 * .integration.test.ts — the v1 route's semantics must never drift from it.
 */
import type { H3Event } from 'h3'
import { getHeader, proxyRequest, readRawBody, setResponseHeader } from 'h3'
import { MEDIA_TOOL_NAMES, WRITE_TOOL_NAMES } from '~~/server/utils/mcp-tool-classes'
import { errorMessage } from '~~/server/utils/content-strings'
import { invalidateBrainCache } from '~~/server/utils/brain-cache'
import { publicMediaBase } from '~~/server/utils/media-url'
import { useDatabaseProvider, useMediaProvider } from '~~/server/utils/providers'
import { checkRateLimit } from '~~/server/utils/rate-limit'
import type { Plan } from '~~/server/utils/license'
import { getPlanLimit, hasFeature } from '~~/server/utils/license'
import { getEffectiveLimit } from '~~/server/utils/overage'
import { reconcileMcpCloudAutoMerge } from '~~/server/utils/mcp-cloud-automerge'
import { incrementOauthUsageIfAllowed } from '~~/server/utils/oauth-server/store'

/**
 * Headers the proxy itself injects — any incoming value is discarded.
 * The media identity headers (project/workspace/owner/plan) are injected
 * ONLY when the request is media-eligible; listing them here still means
 * a client-supplied value is always stripped first, so a forged
 * `x-cr-project-id` can never reach the loopback.
 */
export const STUDIO_HEADERS = [
  'x-cr-installation-id',
  'x-cr-repo-owner',
  'x-cr-repo-name',
  'x-cr-content-root',
  'x-cr-media-base',
  'x-cr-project-id',
  'x-cr-workspace-id',
  'x-cr-media-owner',
  'x-cr-plan',
] as const

/**
 * Best-effort extraction of `tools/call` tool names from a JSON-RPC
 * request body. Handles legacy batch arrays defensively even though the
 * current MCP spec sends one message per POST.
 */
export function extractToolCalls(rawBody: string | undefined): string[] {
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
 * Combine a per-caller monthly cap with the workspace plan's cap — whichever
 * is stricter wins. Null means "no cap enforced by this layer"; the RPC
 * treats null as unlimited. The caller cap can only TIGHTEN the plan cap,
 * never exceed it — a starter key with `monthly_call_limit: 100000`
 * must not unlock 100K calls/month.
 */
export function resolveEffectiveMonthlyLimit(
  planLimit: number,
  callerLimit: number | null,
): number | null {
  const finitePlan = Number.isFinite(planLimit) ? planLimit : null
  if (finitePlan != null && callerLimit != null) return Math.min(finitePlan, callerLimit)
  if (finitePlan != null) return finitePlan
  return callerLimit
}

export interface McpProxyContext {
  projectId: string
  workspaceId: string
  plan: Plan
  overageSettings: Record<string, boolean>
  installationId: number
  repoFullName: string
  contentRoot: string
  /** projects.cdn_enabled — media delivery gate (public media API precedent). */
  cdnEnabled: boolean
  /** workspaces.owner_id — `uploaded_by` for keyless media ingest; null hides media. */
  mediaOwnerId: string | null
  /**
   * Key surface only: an explicit opt-in that lets an empty (unrestricted)
   * allowlist reach media tools. OAuth passes a concrete scope-derived list
   * and never sets this.
   */
  mediaToolsOptIn?: boolean
  /** Empty = unrestricted (key surface); scope-derived set (OAuth surface). */
  allowedTools: string[]
  rateLimitPerMinute: number
  /** e.g. `mcp-cloud:<keyId>` | `mcp-oauth:<grantId>` */
  rateLimitKey: string
  /** Caller-level monthly tightener; null = plan cap only. */
  monthlyCallLimit: number | null
  /** Quota + metering identity — selects the usage table/RPC. */
  meter: { kind: 'key' | 'grant', id: string }
  /** OAuth surface throws its 403 insufficient_scope challenge here. */
  onToolDenied?: (event: H3Event, tool: string) => never
}

/**
 * The shared tail: rate limit → body read → allowlist → quota (tools/call
 * only) → meter → header strip/inject → proxy → brain + auto-merge.
 */
export async function runMcpCloudProxy(
  event: H3Event,
  mcpUrl: string,
  slug: string,
  ctx: McpProxyContext,
): Promise<unknown> {
  const rateCheck = await checkRateLimit(
    ctx.rateLimitKey,
    ctx.rateLimitPerMinute,
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

  // Tool allowlist. Non-media tools: empty = unrestricted, non-empty =
  // whitelist. Media tools are NEVER covered by the empty "unrestricted"
  // semantics — a key minted before the media facet existed must not
  // silently gain URL ingest / destructive delete. They pass only when
  // explicitly listed or (key surface) via the `media_enabled` opt-in.
  // OAuth always passes a concrete `toolsForScope` list, so a media:*
  // grant keeps working and a missing scope still triggers step-up.
  const denied = toolCalls.find((name) => {
    if (MEDIA_TOOL_NAMES.has(name))
      return !ctx.allowedTools.includes(name) && ctx.mediaToolsOptIn !== true
    return ctx.allowedTools.length > 0 && !ctx.allowedTools.includes(name)
  })
  if (denied) {
    if (ctx.onToolDenied) ctx.onToolDenied(event, denied)
    throw createError({
      statusCode: 403,
      message: errorMessage('mcp_cloud.tool_not_allowed', { tool: denied }),
    })
  }

  // Only tool calls consume the monthly quota and produce meter events.
  // Protocol traffic (initialize, tools/list, SSE streams, DELETE) stays
  // free — it is still rate-limited above. Both surfaces draw on ONE
  // combined workspace pool (the RPCs sum both usage tables).
  if (toolCalls.length > 0) {
    const planLimit = getPlanLimit(ctx.plan, 'api.mcp_calls_per_month')
    const softenedPlanLimit = getEffectiveLimit(planLimit, 'api.mcp_calls_per_month', ctx.overageSettings)
    const effectiveLimit = resolveEffectiveMonthlyLimit(
      softenedPlanLimit,
      ctx.monthlyCallLimit,
    )

    const month = new Date().toISOString().slice(0, 7)
    const quota = ctx.meter.kind === 'key'
      ? await useDatabaseProvider().incrementMcpCloudUsageIfAllowed({
          workspaceId: ctx.workspaceId,
          keyId: ctx.meter.id,
          month,
          limit: effectiveLimit,
        })
      : await incrementOauthUsageIfAllowed({
          workspaceId: ctx.workspaceId,
          grantId: ctx.meter.id,
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
    // NOTE: called as the Nitro auto-import global on purpose — the proxy
    // integration tests stub it with vi.stubGlobal.
    recordMCPCallUsage({
      workspaceId: ctx.workspaceId,
      count: 1,
      keyId: ctx.meter.id,
      month,
      source: ctx.meter.kind,
    }).catch(() => {})
  }

  const shouldInvalidateBrain = toolCalls.some(name => WRITE_TOOL_NAMES.has(name))

  const [owner, repoName] = ctx.repoFullName.split('/')
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

  const target = slug.length > 0 ? `${mcpUrl}/${slug}` : mcpUrl

  // Media facet eligibility — the policy decision lives HERE (once, for
  // both surfaces). When eligible, inject the identity headers the
  // loopback turns into the media facet; when not, omit them so the
  // loopback builds a facet-less provider and the media tools stay hidden
  // from tools/list. Requires: the media stack (ee + R2), the plan's
  // media feature, project CDN delivery, and a workspace owner for
  // `uploaded_by`.
  const mediaEligible = useMediaProvider() !== null
    && hasFeature(ctx.plan, 'media.upload')
    && ctx.cdnEnabled
    && ctx.mediaOwnerId !== null

  const response = await proxyRequest(event, target, {
    headers: {
      'x-cr-installation-id': String(ctx.installationId),
      'x-cr-repo-owner': owner,
      'x-cr-repo-name': repoName,
      'x-cr-content-root': ctx.contentRoot,
      // Public media delivery base — lets MCP's content-write path normalize
      // `media/...` references to absolute URLs (provider.mediaBaseUrl).
      'x-cr-media-base': publicMediaBase(ctx.projectId),
      ...(mediaEligible
        ? {
            'x-cr-project-id': ctx.projectId,
            'x-cr-workspace-id': ctx.workspaceId,
            'x-cr-media-owner': ctx.mediaOwnerId!,
            'x-cr-plan': ctx.plan,
          }
        : {}),
      // h3's proxyRequest strips the client's `accept` header (it's in h3's
      // ignoredHeaders set). The MCP streamable-HTTP transport rejects any
      // request whose Accept doesn't include BOTH `application/json` and
      // `text/event-stream` with a 406, so re-inject it here — otherwise
      // every external MCP client fails at `initialize`.
      'accept': getHeader(event, 'accept') || 'application/json, text/event-stream',
    },
    fetchOptions: {
      method: event.method,
      body: rawBody,
    },
  })

  if (shouldInvalidateBrain) {
    invalidateBrainCache(ctx.projectId)

    // MCP's remote write path always reports `pending-review` and delegates
    // the merge to Studio. Land those branches when the project's effective
    // workflow is auto-merge (plan + config aware), matching the native
    // write paths. Fire-and-forget — it can never affect the response the
    // external agent already received.
    void reconcileMcpCloudAutoMerge({
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      installationId: ctx.installationId,
      repoFullName: ctx.repoFullName,
      contentRoot: ctx.contentRoot,
      plan: ctx.plan,
    }).catch(() => {})
  }

  return response
}
