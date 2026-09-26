/**
 * Start moving this project's migrated media into Studio Media — or return
 * the import already open for it. The files are imported by the worker
 * (`server/plugins/migration-media-worker.ts`); this records the job.
 *
 * Owner/admin only: it spends the workspace's storage. Queues the media files
 * the branch holds as listed and within the plan's file cap; the rest come
 * back as `skipped` (the preflight, `GET …/migration/media`, lists them first).
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/migration/media
 *   → 200 { job, created, skipped: { overSize, missing, fontsKept } }
 *   → 403 media.upload_upgrade · 404 migration.media_manifest_missing
 *   → 422 migration.media_manifest_invalid · 429 · 503 media.storage_not_configured
 */

import { migrationSignedOrigin } from '~~/server/utils/migrate-grant'
import { startMigrationMediaImport, toMigrationMediaJobView } from '~~/server/utils/migration-media-import'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  if (!useMediaProvider())
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  const ws = await db.getWorkspaceById(workspaceId, 'plan, overage_settings, media_storage_bytes')
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(ws ?? {})
  if (!hasFeature(plan, 'media.upload'))
    throw createError({ statusCode: 403, message: errorMessage('media.upload_upgrade', getUpgradeParams(plan)) })

  const rate = await checkRateLimit(`migration-media-import:${session.user.id}`, 5, 60_000)
  if (!rate.allowed)
    throw createError({ statusCode: 429, message: errorMessage('migration.media_import_rate_limited') })

  const ctx = await resolveProjectContext(workspaceId, projectId)
  const result = await startMigrationMediaImport({
    projectId,
    workspaceId,
    userId: session.user.id,
    plan,
    usedBytes: Number(ws?.media_storage_bytes ?? 0),
    overageSettings: event.context.billing?.overageSettings ?? (ws?.overage_settings as Record<string, boolean> | null) ?? {},
    git: ctx.git,
    contentRoot: ctx.contentRoot,
    defaultBranch: ctx.project.default_branch ?? 'main',
    signedOrigin: await migrationSignedOrigin(workspaceId, project),
  })
  return { job: toMigrationMediaJobView(result.job), created: result.created, skipped: result.skipped }
})
