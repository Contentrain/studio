/**
 * Load messages for a conversation.
 * Returns messages in chronological order.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const conversationId = getRouterParam(event, 'conversationId')
  const projectId = getRouterParam(event, 'projectId')

  if (!conversationId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.conversation_id_required') })

  // Verify conversation belongs to user
  const conv = await db.getConversation(conversationId, projectId, { userId: session.user.id })

  if (!conv)
    throw createError({ statusCode: 404, message: errorMessage('chat.conversation_not_found') })

  return db.loadConversationMessages(conversationId, 100, 'id, role, content, tool_calls, model, created_at')
})
