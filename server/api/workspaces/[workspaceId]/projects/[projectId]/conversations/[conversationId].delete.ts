/**
 * Delete a conversation and all its messages.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const conversationId = getRouterParam(event, 'conversationId')

  if (!conversationId)
    throw createError({ statusCode: 400, message: 'conversationId is required' })

  const client = useSupabaseUserClient(session.accessToken)

  const { error } = await client
    .from('conversations')
    .delete()
    .eq('id', conversationId)
    .eq('user_id', session.user.id)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return { deleted: true }
})
