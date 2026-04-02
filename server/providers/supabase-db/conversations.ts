/**
 * Conversation, message, and agent usage methods
 * for the Supabase DatabaseProvider.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, getUser } from './helpers'

type ConversationMethods = Pick<
  DatabaseProvider,
  | 'createConversation'
  | 'getConversation'
  | 'listConversations'
  | 'deleteConversation'
  | 'updateConversationTimestamp'
  | 'loadConversationMessages'
  | 'insertMessage'
  | 'getAgentUsage'
  | 'upsertAgentUsage'
  | 'getMonthlyUsageSummary'
  | 'incrementAgentUsageIfAllowed'
  | 'updateAgentUsageTokens'
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

    async getConversation(conversationId, projectId, filters) {
      const admin = getAdmin()
      let query = admin
        .from('conversations')
        .select('id, title, status, user_id, workspace_id, created_at, updated_at')
        .eq('id', conversationId)
        .eq('project_id', projectId)

      if (filters?.userId) query = query.eq('user_id', filters.userId)
      if (filters?.workspaceId) query = query.eq('workspace_id', filters.workspaceId)

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

    async loadConversationMessages(conversationId, limit = 20, fields = 'role, content, tool_calls') {
      const admin = getAdmin()
      const { data } = await admin
        .from('messages')
        .select(fields)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(limit)

      return (data ?? []) as unknown as DatabaseRow[]
    },

    async insertMessage(input) {
      const admin = getAdmin()
      const row: Record<string, unknown> = {
        conversation_id: input.conversationId,
        role: input.role,
        content: input.content,
      }

      if (input.toolCalls) row.tool_calls = input.toolCalls
      if (input.tokenCountInput) row.token_count_input = input.tokenCountInput
      if (input.tokenCountOutput) row.token_count_output = input.tokenCountOutput
      if (input.model) row.model = input.model

      await admin.from('messages').insert(row)
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
      await admin
        .from('agent_usage')
        .update({
          input_tokens: input.inputTokens,
          output_tokens: input.outputTokens,
          updated_at: new Date().toISOString(),
        })
        .eq('workspace_id', input.workspaceId)
        .eq('user_id', input.userId)
        .eq('month', input.month)
        .eq('source', input.source)
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
