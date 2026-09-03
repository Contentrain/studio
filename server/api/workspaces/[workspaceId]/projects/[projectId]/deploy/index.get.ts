/**
 * The project's deploy hook (hint only, never the URL) and its pending
 * scheduled boundaries.
 *
 * GET /api/workspaces/{workspaceId}/projects/{projectId}/deploy
 */

import { readStoredDeployTarget, toPublicDeployTarget } from '~~/server/utils/deploy-hooks'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id, deploy_target')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const stored = readStoredDeployTarget(project.deploy_target)
  const scheduled = await db.listPendingScheduledPublications(projectId)
  return {
    target: stored ? toPublicDeployTarget(stored) : null,
    scheduled: scheduled.map(row => ({
      id: row.id,
      modelId: row.model_id,
      entryId: row.entry_id,
      locale: row.locale,
      kind: row.kind,
      fireAt: row.fire_at,
    })),
  }
})
