/**
 * The project's migration handoff (`.contentrain/migrate/handoff.json` as synced) plus
 * a summary and the comments import state, for the overview card. The summary's runtime state counts Studio's own
 * site binding (the grant's, `getMigrateGrantSiteBindingState`), not only what the handoff knew at delivery.
 *
 * `claimExport` is the comments export held on this repository's Migrate grant
 * (İP-2c) — status and count only, never the payload. It can exist before any
 * handoff reaches the repository.
 *
 * `setup` is where the setup of a project Migrate delivered stands (the setup wizard, `server/utils/migration-setup.ts`):
 * present with a handoff and the grant behind the repository, null otherwise. Each step is `done`, `waiting`,
 * `needs_you` or `skipped`, read from the state the step already has; once all are done or skipped an owner's or
 * admin's read stamps `completedAt` and the wizard does not open again.
 *
 * GET /api/workspaces/{workspaceId}/projects/{projectId}/migration
 */

import type { DatabaseProvider, DatabaseRow, MigrateGrantMediaState } from '~~/server/providers/database'
import { migrateGrantMediaRefusedTooLarge } from '~~/server/utils/migrate-grant-status'
import type { StoredMigrationHandoff } from '~~/server/utils/migration-handoff'
import { summarizeMigrationHandoff, syncMigrationHandoff } from '~~/server/utils/migration-handoff'
import { readMigrationMediaManifest } from '~~/server/utils/migration-media'
import { migrationSetupComplete, migrationSetupSteps, readMigrationSetupRecord } from '~~/server/utils/migration-setup'

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

/** The setup's state for a project with a handoff and a grant; see the module doc. */
async function setupView(input: {
  db: DatabaseProvider
  grant: DatabaseRow
  row: DatabaseRow
  workspaceId: string
  projectId: string
  canWrite: boolean
  comments: { imported: number, export: 'ready' | 'unavailable' | 'imported' | 'expired' | null, atSource: number, sourceExport: boolean }
}) {
  const { db, grant, projectId } = input
  const setup = readMigrationSetupRecord(input.row.migration_setup)
  const job = await db.getLatestMigrationMediaJob(projectId)
  const grantState = (grant.media_state ?? null) as MigrateGrantMediaState | null
  // Only when nothing else says whether the site has media to move: one read of the manifest.
  let manifest = true
  if (!job && !grantState) {
    manifest = await resolveProjectContext(input.workspaceId, projectId)
      .then(ctx => readMigrationMediaManifest(ctx.git, ctx.contentRoot, ctx.project.default_branch ?? 'main'))
      .then(found => !!found, () => false)
  }
  const binding = { state: (grant.site_binding_state ?? null) as string | null, detail: record(grant.site_binding_detail) }
  const steps = migrationSetupSteps({
    record: setup,
    binding,
    comments: input.comments,
    media: { job, grantState, grantDetail: record(grant.media_detail), manifest },
  })
  let completedAt = setup.completed_at ?? null
  if (!completedAt && input.canWrite && migrationSetupComplete(steps)) {
    completedAt = new Date().toISOString()
    await db.mergeProjectMigrationSetup(projectId, { completed_at: completedAt }).catch(() => {})
  }
  const check = setup.live_check ?? null
  return {
    grant: { kind: String(grant.kind ?? ''), plan: (grant.plan ?? null) as string | null },
    steps,
    completedAt,
    liveSiteUrl: (input.row.live_site_url ?? null) as string | null,
    liveCheck: check ? { status: check.status, at: check.at, seenAt: check.seenAt ?? null, seenBy: check.seenBy ?? null } : null,
    forms: {
      models: typeof binding.detail.formModels === 'number' ? binding.detail.formModels : null,
      overLimit: Array.isArray(binding.detail.overLimit) ? binding.detail.overLimit.length : 0,
    },
    media: { jobId: job ? String(job.id) : null, refusedTooLarge: (await migrateGrantMediaRefusedTooLarge(grant).catch(() => undefined)) ?? null },
  }
}

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

  const row = await db.getProjectById(projectId, 'id, repo_full_name, migration_handoff, migration_handoff_synced_at, migration_setup, live_site_url')
  let handoff = (row?.migration_handoff ?? null) as StoredMigrationHandoff | null
  let syncedAt = (row?.migration_handoff_synced_at ?? null) as string | null

  // Nothing stored yet: the repository may have received the handoff after
  // the project was connected (Migrate pushes once the project exists), so
  // look for the file now instead of waiting for someone to find a sync
  // button. Owners/admins only — it persists on the project row. Best-effort:
  // no installation, a malformed file or a Git error all read as "absent".
  // A row stored before the manifest/comments split (no `studio_intake`)
  // is re-read once too, so the export stops riding on every project read.
  if ((!handoff || !handoff.studio_intake) && role !== 'member') {
    try {
      const ctx = await resolveProjectContext(workspaceId, projectId)
      const result = await syncMigrationHandoff({
        projectId,
        git: ctx.git,
        contentRoot: ctx.contentRoot,
        project: { repo_full_name: ctx.project.repo_full_name, default_branch: ctx.project.default_branch ?? 'main' },
      })
      if (result.found && result.handoff) {
        handoff = result.handoff
        syncedAt = new Date().toISOString()
      }
    }
    catch {
      // absent — a legacy row stays as stored
    }
  }

  const repoFullName = typeof row?.repo_full_name === 'string' ? row.repo_full_name : ''
  const held = repoFullName ? await db.getMigrateCommentsExport(workspaceId, repoFullName) : null
  const claimExport = held ? { status: held.status, count: held.comments } : null

  if (!handoff && !claimExport)
    return { present: false, syncedAt: null, summary: null, commentsImported: 0, claimExport: null, setup: null }

  const counts = await db.countCommentsByStatus(projectId)
  const commentsImported = counts.pending + counts.approved + counts.spam + counts.rejected
  if (!handoff)
    return { present: false, syncedAt: null, summary: null, commentsImported, claimExport, setup: null }

  // The site sends to this project once Studio's binding is on its default branch (recorded on the grant).
  const binding = repoFullName ? await db.getMigrateGrantSiteBindingState(workspaceId, repoFullName) : null
  const summary = summarizeMigrationHandoff(handoff, { runtimeBound: binding === 'written' || binding === 'partial' })
  const grant = repoFullName ? await db.getMigrateGrantForProject(workspaceId, repoFullName) : null
  const setup = grant
    ? await setupView({
        db,
        grant,
        row: row ?? {},
        workspaceId,
        projectId,
        canWrite: role !== 'member',
        comments: { imported: commentsImported, export: held?.status ?? null, atSource: summary.comments?.total ?? 0, sourceExport: summary.comments?.hasExport ?? false },
      })
    : null
  return { present: true, syncedAt, summary, commentsImported, claimExport, setup }
})
