/**
 * Get CDN settings for a project.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const data = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'cdn_enabled, cdn_branch')

  if (!data)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  return data
})
