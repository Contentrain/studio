/**
 * The project's migration handoff (`.contentrain/migrate/handoff.json` as synced) plus
 * a summary and the comments import state, for the overview card.
 *
 * `claimExport` is the comments export held on this repository's Migrate grant
 * (İP-2c) — status and count only, never the payload. It can exist before any
 * handoff reaches the repository.
 *
 * GET /api/workspaces/{workspaceId}/projects/{projectId}/migration
 */

import type { StoredMigrationHandoff } from '~~/server/utils/migration-handoff'
import { summarizeMigrationHandoff, syncMigrationHandoff } from '~~/server/utils/migration-handoff'

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

  const row = await db.getProjectById(projectId, 'id, repo_full_name, migration_handoff, migration_handoff_synced_at')
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
    return { present: false, syncedAt: null, summary: null, commentsImported: 0, claimExport: null }

  const counts = await db.countCommentsByStatus(projectId)
  const commentsImported = counts.pending + counts.approved + counts.spam + counts.rejected
  if (!handoff)
    return { present: false, syncedAt: null, summary: null, commentsImported, claimExport }

  return {
    present: true,
    syncedAt,
    summary: summarizeMigrationHandoff(handoff),
    commentsImported,
    claimExport,
  }
})
