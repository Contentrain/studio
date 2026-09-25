/**
 * An import's progress: counts, status, and the files that failed (first 50).
 *
 * GET /api/workspaces/{workspaceId}/projects/{projectId}/migration/media/jobs/{jobId}
 */

import { toMigrationMediaJobView } from '~~/server/utils/migration-media-import'

const FAILURES_SHOWN = 50

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const jobId = getRouterParam(event, 'jobId')
  if (!workspaceId || !projectId || !jobId)
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

  const job = await db.getMigrationMediaJob(projectId, jobId)
  if (!job)
    throw createError({ statusCode: 404, message: errorMessage('migration.media_job_not_found') })
  const failures = Number(job.failed ?? 0) > 0 ? await db.listMigrationMediaItems(jobId, 'failed', FAILURES_SHOWN) : []
  return { job: toMigrationMediaJobView(job, failures) }
})
