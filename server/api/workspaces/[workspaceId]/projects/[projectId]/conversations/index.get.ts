/**
 * List conversations for the current user in a project.
 * Returns most recent first, with title and timestamps.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const projectId = getRouterParam(event, 'projectId')

  if (!projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  return db.listConversations(session.accessToken, projectId, session.user.id)
})
