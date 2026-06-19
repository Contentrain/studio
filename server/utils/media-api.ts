import type { H3Event } from 'h3'
import type { MediaProvider } from '../providers/media'
import type { CDNKeyScope } from './cdn-keys'

export interface MediaApiContext {
  projectId: string
  workspaceId: string
  plan: string
  keyId: string
  /** Workspace owner profile id — used as `uploaded_by` for API uploads. */
  ownerId: string
  overageSettings: Record<string, boolean>
  media: MediaProvider
}

/**
 * Gate + resolve a public media API (`/api/media/v1/...`) request.
 *
 * Mirrors the MCP Cloud proxy's gate order so the external-surface auth
 * story stays consistent: Bearer `cdn_api_keys` validation → project
 * match → scope → per-key hourly rate limit → plan feature → the (ee)
 * media provider. Throws on any gate failure; returns the resolved
 * context on success. `useMediaProvider()` is null in Community Edition,
 * so every media route degrades to 503 there.
 */
export async function resolveMediaApiContext(
  event: H3Event,
  opts: { scope: CDNKeyScope, feature: Parameters<typeof hasFeature>[1], upgradeKey: string },
): Promise<MediaApiContext> {
  const keyData = await validateCDNKey(getHeader(event, 'authorization'))

  const routeProjectId = getRouterParam(event, 'projectId')
  if (!routeProjectId || routeProjectId !== keyData.projectId)
    throw createError({ statusCode: 403, message: errorMessage('cdn.key_mismatch') })

  requireScope(keyData.scopes, opts.scope)

  const rate = await checkRateLimit(`media:${keyData.keyId}`, keyData.rateLimitPerHour, 3_600_000)
  if (!rate.allowed) {
    const retryAfter = Math.max(1, Math.ceil(rate.retryAfterMs / 1000))
    setResponseHeader(event, 'Retry-After', retryAfter)
    throw createError({ statusCode: 429, message: errorMessage('chat.rate_limited', { seconds: retryAfter }) })
  }

  const db = useDatabaseProvider()
  const project = await db.getProjectById(keyData.projectId, 'id, workspace_id, cdn_enabled')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  // Media is delivered over the CDN, so it requires the project to have
  // activated CDN (same gate as the delivery route). Without this, an
  // upload to an un-activated project hits R2 and leaks a raw 500 instead
  // of a clean "CDN not enabled" 403.
  if (!project.cdn_enabled)
    throw createError({ statusCode: 403, message: errorMessage('cdn.not_enabled') })

  const workspace = await db.getWorkspaceById(project.workspace_id as string, 'id, plan, overage_settings, owner_id')
  if (!workspace)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const plan = getWorkspacePlan(workspace)
  if (!hasFeature(plan, opts.feature))
    throw createError({ statusCode: 403, message: errorMessage(opts.upgradeKey, getUpgradeParams(plan)) })

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  return {
    projectId: keyData.projectId,
    workspaceId: project.workspace_id as string,
    plan,
    keyId: keyData.keyId,
    // `media_assets.uploaded_by` is a NOT NULL uuid → profiles(id). API-key
    // uploads have no acting user, so attribute them to the workspace owner
    // (who authorized the key).
    ownerId: workspace.owner_id as string,
    overageSettings: (workspace.overage_settings as Record<string, boolean>) ?? {},
    media,
  }
}
