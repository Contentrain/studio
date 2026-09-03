/**
 * Bulk media ingest from remote URLs — the migration primitive that moves a
 * site's images off its old host and returns the old → new URL map.
 *
 * Same access and plan rules as a single upload (`media.upload`, media stack
 * present); up to 100 URLs per request, bounded concurrency; one failing URL
 * is reported, never aborts the batch. Rate-limited per user.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/media/bulk-ingest
 * body { items: [{ url, alt?, tags?, filename? }], concurrency? }
 */

import { BULK_INGEST_MAX_ITEMS, ingestMediaUrls } from '~~/server/utils/media-bulk-ingest'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  if (role === 'member') {
    const pm = await db.getProjectMember(projectId, session.user.id)
    if (!pm) throw createError({ statusCode: 403, message: errorMessage('project.access_denied') })
  }

  const ws = await db.getWorkspaceById(workspaceId, 'plan')
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(ws ?? {})
  if (!hasFeature(plan, 'media.upload'))
    throw createError({ statusCode: 403, message: errorMessage('media.upload_upgrade', getUpgradeParams(plan)) })

  const body = await readBody<{ items?: unknown, concurrency?: unknown }>(event)
  const items = Array.isArray(body?.items)
    ? body.items.filter((i): i is { url: string, alt?: string, tags?: string[], filename?: string } => !!i && typeof i === 'object' && typeof (i as { url?: unknown }).url === 'string')
    : []
  if (items.length === 0)
    throw createError({ statusCode: 400, message: errorMessage('media.url_required') })
  if (items.length > BULK_INGEST_MAX_ITEMS)
    throw createError({ statusCode: 400, message: errorMessage('media.bulk_ingest_limit', { limit: BULK_INGEST_MAX_ITEMS }) })

  const rate = await checkRateLimit(`media-bulk-ingest:${session.user.id}`, 10, 60_000)
  if (!rate.allowed)
    throw createError({ statusCode: 429, message: errorMessage('media.bulk_ingest_rate_limited') })

  return ingestMediaUrls({
    projectId,
    workspaceId,
    plan,
    uploadedBy: session.user.id,
    items: items.map(i => ({
      url: i.url,
      alt: typeof i.alt === 'string' ? i.alt.slice(0, 500) : undefined,
      tags: Array.isArray(i.tags) ? i.tags.filter((t): t is string => typeof t === 'string').slice(0, 20) : undefined,
      filename: typeof i.filename === 'string' ? i.filename.slice(0, 200) : undefined,
    })),
    concurrency: typeof body?.concurrency === 'number' ? body.concurrency : undefined,
    source: 'url',
  })
})
