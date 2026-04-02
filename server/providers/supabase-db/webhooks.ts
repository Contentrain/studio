/**
 * Webhook and webhook delivery methods for the Supabase DatabaseProvider.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, toDatabaseRowOrNull } from './helpers'

type WebhookMethods = Pick<
  DatabaseProvider,
  | 'listProjectWebhooks'
  | 'getWebhook'
  | 'updateWebhook'
  | 'deleteWebhook'
  | 'listActiveProjectWebhooks'
  | 'createWebhookDelivery'
  | 'listWebhookDeliveries'
  | 'updateWebhookDelivery'
  | 'listPendingWebhookRetries'
  | 'deleteWebhookDeliveries'
  | 'listConversationKeys'
  | 'createConversationKey'
  | 'updateConversationKey'
  | 'revokeConversationKey'
  | 'countActiveConversationKeys'
  | 'getConversationKeyUsage'
>

export function webhookMethods(): WebhookMethods {
  return {
    // ─── Webhooks ───

    async listProjectWebhooks(projectId, workspaceId) {
      const { data, error } = await getAdmin()
        .from('webhooks')
        .select('id, name, url, events, active, created_at, updated_at, secret')
        .eq('project_id', projectId)
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    async getWebhook(webhookId, options) {
      const admin = getAdmin()
      let query = admin
        .from('webhooks')
        .select('id, url, secret, active, name, events, workspace_id, project_id')
        .eq('id', webhookId)

      if (options?.projectId) query = query.eq('project_id', options.projectId)
      if (options?.workspaceId) query = query.eq('workspace_id', options.workspaceId)

      const { data, error } = await query.single()
      if (error) {
        if (error.code === 'PGRST116') return null
        throw createError({ statusCode: 500, message: error.message })
      }
      return toDatabaseRowOrNull(data)
    },

    async updateWebhook(webhookId, projectId, workspaceId, updates) {
      const { data, error } = await getAdmin()
        .from('webhooks')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', webhookId)
        .eq('project_id', projectId)
        .eq('workspace_id', workspaceId)
        .select('id, name, url, events, active, created_at, updated_at')
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data as DatabaseRow
    },

    async deleteWebhook(webhookId, projectId, workspaceId) {
      const admin = getAdmin()
      await admin.from('webhook_deliveries').delete().eq('webhook_id', webhookId)
      const { error } = await admin
        .from('webhooks').delete()
        .eq('id', webhookId).eq('project_id', projectId).eq('workspace_id', workspaceId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async listActiveProjectWebhooks(workspaceId, projectId) {
      const { data, error } = await getAdmin()
        .from('webhooks')
        .select('id, url, events, secret, active')
        .eq('workspace_id', workspaceId)
        .eq('project_id', projectId)
        .eq('active', true)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    // ─── Webhook Deliveries ───

    async createWebhookDelivery(input) {
      const { data, error } = await getAdmin()
        .from('webhook_deliveries')
        .insert({
          webhook_id: input.webhookId,
          event: input.event,
          payload: input.payload,
          status: 'pending',
        })
        .select('id')
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data as DatabaseRow
    },

    async listWebhookDeliveries(webhookId, options) {
      const page = options?.page ?? 1
      const limit = options?.limit ?? 50
      const offset = (page - 1) * limit

      const { data, count, error } = await getAdmin()
        .from('webhook_deliveries')
        .select('id, event, status, response_code, response_body, retry_count, delivered_at, next_retry_at, created_at', { count: 'exact' })
        .eq('webhook_id', webhookId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return { deliveries: (data ?? []) as DatabaseRow[], total: count ?? 0 }
    },

    async updateWebhookDelivery(deliveryId, updates) {
      const { error } = await getAdmin()
        .from('webhook_deliveries')
        .update(updates)
        .eq('id', deliveryId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async listPendingWebhookRetries(limit = 50) {
      const now = new Date().toISOString()
      const { data, error } = await getAdmin()
        .from('webhook_deliveries')
        .select('id, webhook_id, payload, retry_count')
        .eq('status', 'pending')
        .lte('next_retry_at', now)
        .limit(limit)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    async deleteWebhookDeliveries(webhookId) {
      const { error } = await getAdmin()
        .from('webhook_deliveries')
        .delete()
        .eq('webhook_id', webhookId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    // ─── Conversation API Keys CRUD ───

    async listConversationKeys(projectId, workspaceId) {
      const { data, error } = await getAdmin()
        .from('conversation_api_keys')
        .select('id, name, key_prefix, role, specific_models, allowed_models, allowed_tools, allowed_locales, custom_instructions, ai_model, rate_limit_per_minute, monthly_message_limit, last_used_at, created_at, revoked_at')
        .eq('project_id', projectId)
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    async createConversationKey(input) {
      const { data, error } = await getAdmin()
        .from('conversation_api_keys')
        .insert(input)
        .select('id, name, key_prefix, role, specific_models, allowed_models, allowed_tools, allowed_locales, custom_instructions, ai_model, rate_limit_per_minute, monthly_message_limit, created_at')
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data as DatabaseRow
    },

    async updateConversationKey(keyId, projectId, workspaceId, updates) {
      const { data, error } = await getAdmin()
        .from('conversation_api_keys')
        .update(updates)
        .eq('id', keyId)
        .eq('project_id', projectId)
        .eq('workspace_id', workspaceId)
        .select('id, name, role, specific_models, allowed_models, allowed_tools, allowed_locales, custom_instructions, ai_model, rate_limit_per_minute, monthly_message_limit')
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data as DatabaseRow
    },

    async revokeConversationKey(keyId, projectId, workspaceId) {
      const { error } = await getAdmin()
        .from('conversation_api_keys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', keyId)
        .eq('project_id', projectId)
        .eq('workspace_id', workspaceId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async countActiveConversationKeys(projectId, workspaceId) {
      const { count, error } = await getAdmin()
        .from('conversation_api_keys')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('workspace_id', workspaceId)
        .is('revoked_at', null)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return count ?? 0
    },

    async getConversationKeyUsage(keyIds, month) {
      const { data, error } = await getAdmin()
        .from('agent_usage')
        .select('api_key_id, message_count')
        .in('api_key_id', keyIds)
        .eq('month', month)
        .eq('source', 'api')

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },
  }
}
