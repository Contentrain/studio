export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  const data = await db.getProjectWithMembers(session.accessToken, workspaceId, projectId)

  if (!data)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  return data
})
