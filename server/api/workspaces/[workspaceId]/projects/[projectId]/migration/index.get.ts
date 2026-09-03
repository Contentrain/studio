/**
 * The project's migration handoff (`contentrain-handoff.json` as synced) plus
 * a summary and the comments import state, for the overview card.
 *
 * GET /api/workspaces/{workspaceId}/projects/{projectId}/migration
 */

import type { MigrationHandoff } from '@contentrain/types'
import { summarizeMigrationHandoff } from '~~/server/utils/migration-handoff'

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

  const row = await db.getProjectById(projectId, 'id, migration_handoff, migration_handoff_synced_at')
  const handoff = (row?.migration_handoff ?? null) as MigrationHandoff | null
  if (!handoff)
    return { present: false, syncedAt: null, summary: null, commentsImported: 0 }

  const counts = await db.countCommentsByStatus(projectId)
  return {
    present: true,
    syncedAt: row?.migration_handoff_synced_at ?? null,
    summary: summarizeMigrationHandoff(handoff),
    commentsImported: counts.pending + counts.approved + counts.spam + counts.rejected,
  }
})
