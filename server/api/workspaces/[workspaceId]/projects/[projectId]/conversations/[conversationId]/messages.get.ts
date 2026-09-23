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

  // 300 rows: assistant iteration rows are all visible since the trace
  // visibility change (up to ~10 visible rows per heavy turn instead of
  // 2), and tool_result rows — the biggest blobs — stay internal, so
  // the payload cost is narration + tool inputs only. Note the provider
  // orders ascending and applies the limit after, so a conversation
  // beyond the cap truncates its NEWEST turns — a pre-existing wart,
  // tracked separately.
  const rows = await db.loadConversationMessages(conversationId, 300, 'id, role, content, content_blocks, tool_calls, model, created_at, turn_id')
  // Thinking blocks (Opus 5.5) stay in the rows for replay, but the UI never
  // renders them and their signatures are the bulk of the payload.
  return rows.map(row => Array.isArray(row.content_blocks)
    ? { ...row, content_blocks: (row.content_blocks as Array<{ type?: string }>).filter(b => b?.type !== 'thinking' && b?.type !== 'redacted_thinking') }
    : row)
})
