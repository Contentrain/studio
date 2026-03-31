/**
 * List recent CDN builds for a project.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  // Verify project belongs to workspace (access check via RLS)
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id')

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  return db.listCDNBuilds(projectId)
})
