/**
 * Conversation, message, and agent usage methods
 * for the Supabase DatabaseProvider.
 */
import type { DatabaseProvider, DatabaseRow, MessageInsertInput } from '../database'
import { getAdmin, getUser } from './helpers'

function toMessageRow(input: MessageInsertInput): Record<string, unknown> {
  // Every row in a bulk insert MUST carry an identical key set:
  // PostgREST rejects heterogeneous-key arrays with
  // `PGRST102: "All object keys must match"`. Conditionally omitting
  // keys (the old shape) made a trace's seed/assistant/tool_result
  // rows differ, so the whole `insertMessages` batch was rejected —
  // and, because the error went unchecked, silently dropped.
  //
  // So emit the full column set on every row. Nullable columns
  // (content_blocks, tool_calls, iteration, model) default to null;
  // the NOT NULL token counters default to 0, matching their DB
  // column defaults (migrations 008/009).
  return {
    conversation_id: input.conversationId,
    role: input.role,
    content: input.content,
    turn_id: input.turnId,
    turn_sequence: input.turnSequence,
    internal: input.internal,
    content_blocks: input.contentBlocks && input.contentBlocks.length > 0 ? input.contentBlocks : null,
    tool_calls: input.toolCalls ?? null,
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
      const admin = getAdmin()
      const { data } = await admin
        .from('conversations')
        .insert({
          project_id: projectId,
          user_id: userId,
          title: title.substring(0, 100),
        })
        .select('id')
        .single()

      return data?.id ?? null
    },

    async createApiConversation(projectId, apiKeyId, title) {
      const admin = getAdmin()
      const { data } = await admin
        .from('conversations')
        .insert({
          project_id: projectId,
          api_key_id: apiKeyId,
          title: title.substring(0, 100),
        })
        .select('id')
        .single()

      return data?.id ?? null
    },

    async getConversation(conversationId, projectId, filters) {
      const admin = getAdmin()
      let query = admin
        .from('conversations')
        .select('id, title, user_id, api_key_id, created_at, updated_at')
        .eq('id', conversationId)
        .eq('project_id', projectId)

      if (filters && 'userId' in filters) query = query.eq('user_id', filters.userId)
      else if (filters && 'apiKeyId' in filters) query = query.eq('api_key_id', filters.apiKeyId)

      const { data, error } = await query.single()
      if (error) {
        if (error.code === 'PGRST116') return null
        throw createError({ statusCode: 500, message: error.message })
      }
      return data
    },

    async listConversations(accessToken, projectId, userId) {
      const client = getUser(accessToken)
      const { data, error } = await client
        .from('conversations')
        .select('id, title, created_at, updated_at')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })

      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? []) as unknown as DatabaseRow[]
    },

    async deleteConversation(accessToken, conversationId, userId, projectId) {
      const client = getUser(accessToken)
      const { error } = await client
        .from('conversations')
        .delete()
        .eq('id', conversationId)
        .eq('user_id', userId)
        .eq('project_id', projectId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async updateConversationTimestamp(conversationId) {
      const admin = getAdmin()
      await admin
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversationId)
    },

    async loadConversationMessages(conversationId, limit = 20, fields = 'role, content, tool_calls, content_blocks, turn_id, turn_sequence, iteration, internal', options) {
      const admin = getAdmin()
      let query = admin
        .from('messages')
        .select(fields)
        .eq('conversation_id', conversationId)
      // Ordering by `(created_at, turn_sequence)` keeps batch-inserted
      // rows with identical timestamps in protocol order.
      query = query.order('created_at', { ascending: true })
      query = query.order('turn_sequence', { ascending: true })

      if (!options?.includeInternal) {
        query = query.eq('internal', false)
      }

      const { data } = await query.limit(limit)

      return (data ?? []) as unknown as DatabaseRow[]
    },

    async insertMessage(input) {
      const admin = getAdmin()
      const { error } = await admin.from('messages').insert(toMessageRow(input))
      if (error) throw createError({ statusCode: 500, message: `Failed to insert message: ${error.message}` })
    },

    async insertMessages(rows) {
      if (rows.length === 0) return
      const admin = getAdmin()
      // `.insert()` resolves with `{ error }` rather than throwing —
      // surface failures so the caller's `[chat-persist]` handler logs
      // and the turn reports the error instead of silently losing the
      // entire conversation trace.
      const { error } = await admin.from('messages').insert(rows.map(toMessageRow))
      if (error) throw createError({ statusCode: 500, message: `Failed to insert messages: ${error.message}` })
    },

    // ─── Agent Usage ───

    async getAgentUsage(workspaceId, month, source, identifiers) {
      const admin = getAdmin()
      let query = admin
        .from('agent_usage')
        .select('id, message_count, input_tokens, output_tokens')
        .eq('workspace_id', workspaceId)
        .eq('month', month)
        .eq('source', source)

      if (identifiers.apiKeyId) {
        query = query.eq('api_key_id', identifiers.apiKeyId)
      }
      else if (identifiers.userId) {
        query = query.eq('user_id', identifiers.userId)
      }

      const { data } = await query.single()
      return data ?? null
    },

    async upsertAgentUsage(input) {
      const admin = getAdmin()

      // Try update existing
      let query = admin
        .from('agent_usage')
        .select('id, message_count, input_tokens, output_tokens')
        .eq('workspace_id', input.workspaceId)
        .eq('month', input.month)
        .eq('source', input.source)

      if (input.apiKeyId) {
        query = query.eq('api_key_id', input.apiKeyId)
      }
      else {
        query = query.eq('user_id', input.userId)
      }

      const { data: existing } = await query.single()

      if (existing) {
        await admin.from('agent_usage').update({
          message_count: (existing.message_count ?? 0) + input.messageCount,
          input_tokens: (existing.input_tokens ?? 0) + input.inputTokens,
          output_tokens: (existing.output_tokens ?? 0) + input.outputTokens,
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id)
      }
      else {
        await admin.from('agent_usage').insert({
          workspace_id: input.workspaceId,
          user_id: input.userId,
          ...(input.apiKeyId ? { api_key_id: input.apiKeyId } : {}),
          month: input.month,
          source: input.source,
          message_count: input.messageCount,
          input_tokens: input.inputTokens,
          output_tokens: input.outputTokens,
        })
      }
    },

    async getMonthlyUsageSummary(workspaceId, userId, month) {
      const admin = getAdmin()
      const { data } = await admin
        .from('agent_usage')
        .select('message_count')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .eq('month', month)

      return (data ?? []).reduce((sum: number, r: Record<string, unknown>) => sum + ((r.message_count as number) ?? 0), 0)
    },

    async incrementAgentUsageIfAllowed(input) {
      const admin = getAdmin()
      const { data, error } = await admin.rpc('increment_agent_usage_if_allowed', {
        p_workspace_id: input.workspaceId,
        p_user_id: input.userId,
        p_api_key_id: input.apiKeyId ?? null,
        p_month: input.month,
        p_source: input.source,
        p_limit: input.limit,
      })

      if (error) {
        throw createError({ statusCode: 500, message: `Atomic usage check failed: ${error.message}` })
      }

      const result = data as { allowed: boolean, current_count: number }
      return { allowed: result.allowed, currentCount: result.current_count }
    },

    async updateAgentUsageTokens(input) {
      const admin = getAdmin()
      // _v2 RPC carries the cache token columns alongside the base
      // input/output counters; the legacy _v1 entry point stays
      // registered for rolling-deploy safety but is no longer called
      // from app code.
      await admin.rpc('increment_agent_usage_tokens_v2', {
        p_workspace_id: input.workspaceId,
        p_user_id: input.userId,
        p_month: input.month,
        p_source: input.source,
        p_input_tokens: input.inputTokens,
        p_output_tokens: input.outputTokens,
        p_cache_creation_input_tokens: input.cacheCreationInputTokens,
        p_cache_read_input_tokens: input.cacheReadInputTokens,
      })
    },

    async decrementAgentUsage(input) {
      const admin = getAdmin()
      const { error } = await admin.rpc('decrement_agent_usage', {
        p_workspace_id: input.workspaceId,
        p_user_id: input.userId,
        p_month: input.month,
        p_source: input.source,
      })
      if (error) {
        throw createError({ statusCode: 500, message: `Agent usage revert failed: ${error.message}` })
      }
    },

    // ─── API Message Usage (Conversation API) ───

    async incrementAPIUsageIfAllowed(input) {
      const admin = getAdmin()
      const { data, error } = await admin.rpc('increment_api_usage_if_allowed', {
        p_workspace_id: input.workspaceId,
        p_api_key_id: input.apiKeyId,
        p_month: input.month,
        p_key_limit: input.keyLimit,
        p_workspace_limit: input.workspaceLimit,
      })

      if (error) {
        throw createError({ statusCode: 500, message: `Atomic API usage check failed: ${error.message}` })
      }

      const result = data as { allowed: boolean, reason: 'ok' | 'key_limit' | 'workspace_limit', current: number }
      return result
    },

    async updateAPIUsageTokens(input) {
      const admin = getAdmin()
      await admin.rpc('increment_api_usage_tokens_v2', {
        p_workspace_id: input.workspaceId,
        p_api_key_id: input.apiKeyId,
        p_month: input.month,
        p_input_tokens: input.inputTokens,
        p_output_tokens: input.outputTokens,
        p_cache_creation_input_tokens: input.cacheCreationInputTokens,
        p_cache_read_input_tokens: input.cacheReadInputTokens,
      })
    },

    async decrementAPIUsage(input) {
      const admin = getAdmin()
      const { error } = await admin.rpc('decrement_api_usage', {
        p_workspace_id: input.workspaceId,
        p_api_key_id: input.apiKeyId,
        p_month: input.month,
      })
      if (error) {
        throw createError({ statusCode: 500, message: `API usage revert failed: ${error.message}` })
      }
    },

    // ─── BYOA Key ───

    async getBYOAKey(accessToken, workspaceId, userId) {
      const client = getUser(accessToken)
      const { data } = await client
        .from('ai_keys')
        .select('encrypted_key')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .eq('provider', 'anthropic')
        .single()

      return (data?.encrypted_key as string) ?? null
    },
  }
}
