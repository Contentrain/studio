/**
 * Fire the project's deploy hook now (bypasses the debounce). Workspace owner/admin.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/deploy/trigger
 */

import { triggerProjectDeploy } from '~~/server/utils/deploy-hooks'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const rate = await checkRateLimit(`deploy-trigger:${projectId}`, 6, 60_000)
  if (!rate.allowed)
    throw createError({ statusCode: 429, message: errorMessage('forms.rate_limited') })

  const result = await triggerProjectDeploy({ projectId, workspaceId, reason: 'manual', immediate: true })
  if (!result)
    throw createError({ statusCode: 404, message: errorMessage('deploy.not_configured') })
  if (!result.ok)
    throw createError({ statusCode: 502, message: errorMessage('deploy.trigger_failed', { status: String(result.status) }) })
  return result
})
