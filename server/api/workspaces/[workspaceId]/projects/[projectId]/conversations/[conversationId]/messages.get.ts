/**
 * Load messages for a conversation.
 * Returns messages in chronological order.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const conversationId = getRouterParam(event, 'conversationId')

  if (!conversationId)
    throw createError({ statusCode: 400, message: 'conversationId is required' })

  const client = useSupabaseUserClient(session.accessToken)

  // Verify conversation belongs to user (RLS handles this, but explicit check for clear error)
  const projectId = getRouterParam(event, 'projectId')
  const { data: conv } = await client
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', session.user.id)
    .eq('project_id', projectId!)
    .single()

  if (!conv)
    throw createError({ statusCode: 404, message: 'Conversation not found' })

  const { data, error } = await client
    .from('messages')
    .select('id, role, content, tool_calls, model, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(100)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return data
})
