/**
 * Point the migrated site at its media in Studio, once the import is done:
 * rewrite every recorded reference to the Studio delivery URL, bind
 * `studio.json` (the starter's image `remotePatterns`), and — only when asked
 * and nothing can still point at them — delete the local `public/media/` files.
 * See `server/utils/migration-media-apply.ts`.
 *
 * One commit on a `cr/media/…` branch forked from the snapshot the files were
 * read at, then the project's own workflow decides: auto-merge lands it
 * (`contentrain`, then `main` — the same path every content save takes). On a
 * review project this click is the caller's approval (F2): recorded with their
 * role and the note, then merged under it with a receipt; a policy that wants
 * more than one grant leaves it pending for its reviewers. A write that landed
 * since the read makes the merge a conflict, never an overwrite.
 *
 * The one place the UI moves the media from (the project's media card, or any
 * setup step that offers it): the approval rides on this call, not on a page.
 *
 * Owner/admin only. `dryRun` defaults to true: the counts, nothing written.
 *
 * The new addresses are keyless CDN delivery URLs, so the switch is refused
 * while the CDN route would not serve them (`publicMediaBlock`: CDN off,
 * public media off, plan without `cdn.delivery`) — written anyway, every
 * image 403s and a site build that fetches them fails. The dry run reports
 * the same reason as `blocked` so the card can say what to turn on first.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/migration/media/apply
 *   { dryRun?: boolean, deleteLocal?: boolean }
 *   → 200 { status: 'dry_run' | 'nothing_to_do' | 'merged' | 'pending_review', counts, blocked?, branch?, pullRequestUrl? }
 *   → 409 migration.media_import_not_done · migration.media_apply_conflict
 *   → 409 migration.media_cdn_disabled · migration.media_public_off · 403 cdn.upgrade
 */

import { applyMigrationMedia } from '~~/server/utils/migration-media-write'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id, cdn_enabled, cdn_public_media')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const body = await readBody<{ dryRun?: unknown, deleteLocal?: unknown }>(event).catch(() => null)
  const dryRun = body?.dryRun !== false
  const deleteLocal = body?.deleteLocal === true

  const job = await db.getLatestMigrationMediaJob(projectId)
  if (!job || job.status !== 'done')
    throw createError({ statusCode: 409, message: errorMessage('migration.media_import_not_done') })

  const rate = await checkRateLimit(`migration-media-apply:${session.user.id}`, 10, 60_000)
  if (!rate.allowed)
    throw createError({ statusCode: 429, message: errorMessage('migration.media_import_rate_limited') })

  const { git, contentRoot, workspace, project: row } = await resolveProjectContext(workspaceId, projectId)
  return applyMigrationMedia({
    db,
    git,
    contentRoot,
    projectId,
    defaultBranch: row.default_branch ?? 'main',
    plan: event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace),
    project,
    job,
    dryRun,
    deleteLocal,
    authorEmail: session.user.email ?? null,
    ...(session.user.email ? { approver: { id: session.user.id, email: session.user.email, role: role ?? null, workspaceId } } : {}),
  })
})
