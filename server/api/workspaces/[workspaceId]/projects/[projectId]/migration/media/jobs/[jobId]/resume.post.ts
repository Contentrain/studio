/**
 * Continue an import that paused because the workspace's storage ran out —
 * after an upgrade, an overage switch, or freeing space. The worker picks it
 * up again from the file it stopped at.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/migration/media/jobs/{jobId}/resume
 *   → 200 { job } · 404 migration.media_job_not_found · 409 migration.media_job_not_paused
 */

import { toMigrationMediaJobView } from '~~/server/utils/migration-media-import'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const jobId = getRouterParam(event, 'jobId')
  if (!workspaceId || !projectId || !jobId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const resumed = await db.resumeMigrationMediaJob(projectId, jobId)
  if (resumed) return { job: toMigrationMediaJobView(resumed) }
  const job = await db.getMigrationMediaJob(projectId, jobId)
  if (!job)
    throw createError({ statusCode: 404, message: errorMessage('migration.media_job_not_found') })
  throw createError({ statusCode: 409, message: errorMessage('migration.media_job_not_paused') })
})
