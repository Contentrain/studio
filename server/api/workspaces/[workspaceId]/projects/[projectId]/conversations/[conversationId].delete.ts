/**
 * Delete a conversation and all its messages.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const conversationId = getRouterParam(event, 'conversationId')

  if (!conversationId)
    throw createError({ statusCode: 400, message: errorMessage('validation.conversation_id_required') })

  const client = db.getUserClient(session.accessToken)

  const projectId = getRouterParam(event, 'projectId')

  const { error } = await client
    .from('conversations')
    .delete()
    .eq('id', conversationId)
    .eq('user_id', session.user.id)
    .eq('project_id', projectId!)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return { deleted: true }
})
