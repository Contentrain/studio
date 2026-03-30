/**
 * Conversation API — history endpoint.
 *
 * Auth: Bearer API key (crn_conv_*), not session-based.
 * Returns conversation message history for a given conversationId.
 */
export default defineEventHandler(async (event) => {
  // === VALIDATE API KEY ===
  const authHeader = getHeader(event, 'authorization')
  const keyData = await validateConversationKey(authHeader)

  // === VERIFY PROJECT MATCH ===
  const routeProjectId = getRouterParam(event, 'projectId')
  if (!routeProjectId || routeProjectId !== keyData.projectId)
    throw createError({ statusCode: 403, message: errorMessage('conversation.key_invalid') })

  // === CONVERSATION ID ===
  const query = getQuery(event)
  const conversationId = query.conversationId as string | undefined
  if (!conversationId)
    throw createError({ statusCode: 400, message: errorMessage('validation.conversation_id_required') })

  // === PLAN CHECK ===
  const admin = useSupabaseAdmin()
  const { data: workspace } = await admin
    .from('workspaces')
    .select('plan')
    .eq('id', keyData.workspaceId)
    .single()

  const plan = getWorkspacePlan(workspace ?? {})
  if (!hasFeature(plan, 'api.conversation'))
    throw createError({ statusCode: 403, message: errorMessage('conversation.upgrade') })

  // === VERIFY CONVERSATION BELONGS TO PROJECT ===
  const { data: conv } = await admin
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('project_id', keyData.projectId)
    .single()

  if (!conv)
    throw createError({ statusCode: 404, message: errorMessage('chat.conversation_not_found') })

  // === FETCH MESSAGES ===
  const limit = Math.min(Number(query.limit ?? 50), 100)
  const { data: messageRows } = await admin
    .from('messages')
    .select('id, role, content, tool_calls, model, token_count_input, token_count_output, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit)

  const messages = (messageRows ?? []).map(row => ({
    id: row.id,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls ?? undefined,
    model: row.model ?? undefined,
    usage: (row.token_count_input || row.token_count_output)
      ? { inputTokens: row.token_count_input ?? 0, outputTokens: row.token_count_output ?? 0 }
      : undefined,
    createdAt: row.created_at,
  }))

  return { conversationId, messages }
})
