/**
 * List conversations for the current user in a project.
 * Returns most recent first, with title and timestamps.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const client = db.getUserClient(session.accessToken)

  const { data, error } = await client
    .from('conversations')
    .select('id, title, created_at, updated_at')
    .eq('project_id', projectId)
    .eq('user_id', session.user.id)
    .order('updated_at', { ascending: false })
    .limit(20)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return data
})
