/**
 * What moving this project's migrated media into Studio Media would take — read
 * from `.contentrain/migrate/media.json` and the branch's tree, nothing moved.
 *
 * Counts the media assets (fonts stay in the repository), their bytes, the
 * ones over the plan's per-file cap, the ones the branch does not hold as
 * listed, and whether the rest fits the workspace's remaining storage; when it
 * does not, the lowest plan that would take all of it. Limits come only from
 * the plan catalog (`getPlanLimit`, overage-aware), never from a plan name.
 *
 * GET /api/workspaces/{workspaceId}/projects/{projectId}/migration/media
 *   → 200 { present: false }
 *   → 200 { present: true, manifest: { path, ref }, job (the latest import, or null), uploadAllowed, upgradeParams?, preflight }
 *   → 422 migration.media_manifest_invalid · 413 migration.media_manifest_too_large
 *   → 503 media.storage_not_configured (no media stack in this edition/deployment)
 */

import { planMigrationMediaPreflight, readMigrationMediaManifest } from '~~/server/utils/migration-media'
import { toMigrationMediaJobView } from '~~/server/utils/migration-media-import'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })
  if (role === 'member') {
    const pm = await db.getProjectMember(projectId, session.user.id)
    if (!pm) throw createError({ statusCode: 403, message: errorMessage('project.access_denied') })
  }

  if (!useMediaProvider())
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  const ctx = await resolveProjectContext(workspaceId, projectId)
  const found = await readMigrationMediaManifest(ctx.git, ctx.contentRoot, ctx.project.default_branch ?? 'main')
  if (!found) return { present: false }

  const ws = await db.getWorkspaceById(workspaceId, 'plan, overage_settings, media_storage_bytes')
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(ws ?? {})
  const uploadAllowed = hasFeature(plan, 'media.upload')
  const tree = await ctx.git.getTree(found.ref)
  const latest = await db.getLatestMigrationMediaJob(projectId)

  return {
    present: true,
    manifest: { path: found.path, ref: found.ref },
    job: latest ? toMigrationMediaJobView(latest) : null,
    uploadAllowed,
    ...(uploadAllowed ? {} : { upgradeParams: getUpgradeParams(plan) }),
    preflight: planMigrationMediaPreflight({
      manifest: found.manifest,
      tree,
      plan,
      usedBytes: Number(ws?.media_storage_bytes ?? 0),
      overageSettings: (ws?.overage_settings as Record<string, boolean> | null) ?? {},
    }),
  }
})
