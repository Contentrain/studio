/**
 * Delete a conversation and all its messages.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const conversationId = getRouterParam(event, 'conversationId')
  const projectId = getRouterParam(event, 'projectId')

  if (!conversationId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.conversation_id_required') })

  await db.deleteConversation(session.accessToken, conversationId, session.user.id, projectId)

  return { deleted: true }
})
