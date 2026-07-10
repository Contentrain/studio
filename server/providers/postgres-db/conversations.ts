/**
 * Conversation, message, and agent usage methods for the plain-Postgres
 * DatabaseProvider.
 *
 * Behavior parity with supabase-db/conversations.ts, including its
 * deliberate error contracts: conversation creation and timestamp/token
 * bookkeeping swallow failures (chat must not break on telemetry), while
 * message persistence and the atomic quota RPCs surface 500s.
 */
import { sql } from 'kysely'
import type { DatabaseProvider, DatabaseRow, MessageInsertInput } from '../database'
import { getAdmin, pickColumns, throwDbError, withUser } from './helpers'

/**
 * Full column set on every row (same shape the Supabase impl emits for
 * PostgREST's homogeneous-keys rule). jsonb payloads are stringified —
 * node-pg would otherwise serialize JS arrays as Postgres ARRAY literals.
 */
function toMessageRow(input: MessageInsertInput) {
  return {
    conversation_id: input.conversationId,
    role: input.role,
    content: input.content,
    turn_id: input.turnId,
    turn_sequence: input.turnSequence,
    internal: input.internal,
    content_blocks: input.contentBlocks && input.contentBlocks.length > 0
      ? JSON.stringify(input.contentBlocks)
      : null,
    tool_calls: input.toolCalls ? JSON.stringify(input.toolCalls) : null,
    iteration: input.iteration ?? null,
    token_count_input: input.tokenCountInput ?? 0,
    token_count_output: input.tokenCountOutput ?? 0,
    cache_creation_input_tokens: input.cacheCreationInputTokens ?? 0,
    cache_read_input_tokens: input.cacheReadInputTokens ?? 0,
    model: input.model ?? null,
  }
}

type ConversationMethods = Pick<
  DatabaseProvider,
  | 'createConversation'
  | 'createApiConversation'
  | 'getConversation'
  | 'listConversations'
  | 'deleteConversation'
  | 'updateConversationTimestamp'
  | 'loadConversationMessages'
  | 'insertMessage'
  | 'insertMessages'
  | 'getAgentUsage'
  | 'upsertAgentUsage'
  | 'getMonthlyUsageSummary'
  | 'incrementAgentUsageIfAllowed'
  | 'updateAgentUsageTokens'
  | 'decrementAgentUsage'
  | 'incrementAPIUsageIfAllowed'
  | 'updateAPIUsageTokens'
  | 'decrementAPIUsage'
  | 'getBYOAKey'
>

export function conversationMethods(): ConversationMethods {
  return {
    async createConversation(projectId, userId, title) {
      // Failure reads as null (the Supabase impl never checks the error).
      try {
        const row = await getAdmin()
          .insertInto('conversations')
          .values({ project_id: projectId, user_id: userId, title: title.substring(0, 100) })
          .returning('id')
          .executeTakeFirst()

        return row?.id ?? null
      }
      catch {
        return null
      }
    },

    async createApiConversation(projectId, apiKeyId, title) {
      try {
        const row = await getAdmin()
          .insertInto('conversations')
          .values({ project_id: projectId, api_key_id: apiKeyId, title: title.substring(0, 100) })
          .returning('id')
          .executeTakeFirst()

        return row?.id ?? null
      }
      catch {
        return null
      }
    },

    async getConversation(conversationId, projectId, filters) {
      try {
        let query = getAdmin()
          .selectFrom('conversations')
          .select(['id', 'title', 'user_id', 'api_key_id', 'created_at', 'updated_at'])
          .where('id', '=', conversationId)
          .where('project_id', '=', projectId)

        if (filters && 'userId' in filters)
          query = query.where('user_id', '=', filters.userId)
        else if (filters && 'apiKeyId' in filters)
          query = query.where('api_key_id', '=', filters.apiKeyId)

        const row = await query.executeTakeFirst()
        return (row as DatabaseRow | undefined) ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listConversations(accessToken, projectId, userId) {
      try {
        return await withUser(accessToken, async trx =>
          await trx
            .selectFrom('conversations')
            .select(['id', 'title', 'created_at', 'updated_at'])
            .where('project_id', '=', projectId)
            .where('user_id', '=', userId)
            .orderBy('created_at', 'desc')
            .execute() as DatabaseRow[])
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async deleteConversation(accessToken, conversationId, userId, projectId) {
      try {
        await withUser(accessToken, trx =>
          trx.deleteFrom('conversations')
            .where('id', '=', conversationId)
            .where('user_id', '=', userId)
            .where('project_id', '=', projectId)
            .execute())
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async updateConversationTimestamp(conversationId) {
      // Fire-and-forget in the Supabase impl — mirror it.
      try {
        await getAdmin()
          .updateTable('conversations')
          .set({ updated_at: new Date().toISOString() })
          .where('id', '=', conversationId)
          .execute()
      }
      catch {
        // parity: swallowed
      }
    },

    async loadConversationMessages(conversationId, limit = 20, fields = 'role, content, tool_calls, content_blocks, turn_id, turn_sequence, iteration, internal', options) {
      // Failure reads as [] (the Supabase impl never checks the error).
      // Ordering by (created_at, turn_sequence) keeps batch-inserted rows
      // with identical timestamps in protocol order.
      try {
        let query = getAdmin()
          .selectFrom('messages')
          .selectAll()
          .where('conversation_id', '=', conversationId)

        if (!options?.includeInternal)
          query = query.where('internal', '=', false)

        const rows = await query
          .orderBy('created_at', 'asc')
          .orderBy('turn_sequence', 'asc')
          .limit(limit)
          .execute()

        return rows.map(row => pickColumns(row as DatabaseRow, fields))
      }
      catch {
        return []
      }
    },

    async insertMessage(input) {
      try {
        await getAdmin().insertInto('messages').values(toMessageRow(input)).execute()
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Failed to insert message: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    async insertMessages(rows) {
      if (rows.length === 0) return
      // Surface failures so the caller's [chat-persist] handler logs them —
      // a silently dropped batch loses the whole conversation trace.
      try {
        await getAdmin().insertInto('messages').values(rows.map(toMessageRow)).execute()
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Failed to insert messages: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    // ─── Agent Usage ───

    async getAgentUsage(workspaceId, month, source, identifiers) {
      try {
        let query = getAdmin()
          .selectFrom('agent_usage')
          .select(['id', 'message_count', 'input_tokens', 'output_tokens'])
          .where('workspace_id', '=', workspaceId)
          .where('month', '=', month)
          .where('source', '=', source)

        if (identifiers.apiKeyId)
          query = query.where('api_key_id', '=', identifiers.apiKeyId)
        else if (identifiers.userId)
          query = query.where('user_id', '=', identifiers.userId)

        const row = await query.executeTakeFirst()
        return (row as DatabaseRow | undefined) ?? null
      }
      catch {
        return null
      }
    },

    async upsertAgentUsage(input) {
      // Read-then-write like the Supabase impl (whose write errors are also
      // unchecked). The quota-bearing path is incrementAgentUsageIfAllowed;
      // this method only backfills aggregates.
      try {
        let query = getAdmin()
          .selectFrom('agent_usage')
          .select(['id', 'message_count', 'input_tokens', 'output_tokens'])
          .where('workspace_id', '=', input.workspaceId)
          .where('month', '=', input.month)
          .where('source', '=', input.source)

        query = input.apiKeyId
          ? query.where('api_key_id', '=', input.apiKeyId)
          : query.where('user_id', '=', input.userId)

        const existing = await query.executeTakeFirst()

        if (existing) {
          await getAdmin()
            .updateTable('agent_usage')
            .set({
              message_count: (existing.message_count ?? 0) + input.messageCount,
              input_tokens: (existing.input_tokens ?? 0) + input.inputTokens,
              output_tokens: (existing.output_tokens ?? 0) + input.outputTokens,
              updated_at: new Date().toISOString(),
            })
            .where('id', '=', existing.id)
            .execute()
        }
        else {
          await getAdmin()
            .insertInto('agent_usage')
            .values({
              workspace_id: input.workspaceId,
              user_id: input.userId,
              ...(input.apiKeyId ? { api_key_id: input.apiKeyId } : {}),
              month: input.month,
              source: input.source,
              message_count: input.messageCount,
              input_tokens: input.inputTokens,
              output_tokens: input.outputTokens,
            })
            .execute()
        }
      }
      catch {
        // parity: swallowed
      }
    },

    async getMonthlyUsageSummary(workspaceId, userId, month) {
      try {
        const row = await getAdmin()
          .selectFrom('agent_usage')
          .select(eb => eb.fn.coalesce(eb.fn.sum('message_count'), eb.lit(0)).as('total'))
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', userId)
          .where('month', '=', month)
          .executeTakeFirst()

        return Number(row?.total ?? 0)
      }
      catch {
        return 0
      }
    },

    async incrementAgentUsageIfAllowed(input) {
      let result: { allowed: boolean, current_count: number }
      try {
        const outcome = await sql<{ result: typeof result }>`
          SELECT public.increment_agent_usage_if_allowed(
            p_workspace_id => ${input.workspaceId},
            p_user_id => ${input.userId},
            p_api_key_id => ${input.apiKeyId ?? null},
            p_month => ${input.month},
            p_source => ${input.source},
            p_limit => ${input.limit}
          ) AS result
        `.execute(getAdmin())

        result = outcome.rows[0]!.result
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Atomic usage check failed: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }

      return { allowed: result.allowed, currentCount: result.current_count }
    },

    async updateAgentUsageTokens(input) {
      // _v2 carries the cache token counters; failures are swallowed like the
      // Supabase impl (token bookkeeping must not break the turn).
      try {
        await sql`
          SELECT public.increment_agent_usage_tokens_v2(
            p_workspace_id => ${input.workspaceId},
            p_user_id => ${input.userId},
            p_month => ${input.month},
            p_source => ${input.source},
            p_input_tokens => ${input.inputTokens},
            p_output_tokens => ${input.outputTokens},
            p_cache_creation_input_tokens => ${input.cacheCreationInputTokens},
            p_cache_read_input_tokens => ${input.cacheReadInputTokens}
          )
        `.execute(getAdmin())
      }
      catch {
        // parity: swallowed
      }
    },

    async decrementAgentUsage(input) {
      try {
        await sql`
          SELECT public.decrement_agent_usage(
            p_workspace_id => ${input.workspaceId},
            p_user_id => ${input.userId},
            p_month => ${input.month},
            p_source => ${input.source}
          )
        `.execute(getAdmin())
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Agent usage revert failed: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    // ─── API Message Usage (Conversation API) ───

    async incrementAPIUsageIfAllowed(input) {
      try {
        const outcome = await sql<{ result: { allowed: boolean, reason: 'ok' | 'key_limit' | 'workspace_limit', current: number } }>`
          SELECT public.increment_api_usage_if_allowed(
            p_workspace_id => ${input.workspaceId},
            p_api_key_id => ${input.apiKeyId},
            p_month => ${input.month},
            p_key_limit => ${input.keyLimit},
            p_workspace_limit => ${input.workspaceLimit}
          ) AS result
        `.execute(getAdmin())

        return outcome.rows[0]!.result
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Atomic API usage check failed: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    async updateAPIUsageTokens(input) {
      try {
        await sql`
          SELECT public.increment_api_usage_tokens_v2(
            p_workspace_id => ${input.workspaceId},
            p_api_key_id => ${input.apiKeyId},
            p_month => ${input.month},
            p_input_tokens => ${input.inputTokens},
            p_output_tokens => ${input.outputTokens},
            p_cache_creation_input_tokens => ${input.cacheCreationInputTokens},
            p_cache_read_input_tokens => ${input.cacheReadInputTokens}
          )
        `.execute(getAdmin())
      }
      catch {
        // parity: swallowed
      }
    },

    async decrementAPIUsage(input) {
      try {
        await sql`
          SELECT public.decrement_api_usage(
            p_workspace_id => ${input.workspaceId},
            p_api_key_id => ${input.apiKeyId},
            p_month => ${input.month}
          )
        `.execute(getAdmin())
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `API usage revert failed: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    // ─── BYOA Key ───

    async getBYOAKey(accessToken, workspaceId, userId) {
      // Failure reads as null (the Supabase impl never checks the error).
      try {
        return await withUser(accessToken, async (trx) => {
          const row = await trx
            .selectFrom('ai_keys')
            .select('encrypted_key')
            .where('workspace_id', '=', workspaceId)
            .where('user_id', '=', userId)
            .where('provider', '=', 'anthropic')
            .executeTakeFirst()

          return row?.encrypted_key ?? null
        })
      }
      catch {
        return null
      }
    },
  }
}
