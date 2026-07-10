/**
 * Webhook, webhook delivery, and conversation-key CRUD methods for the
 * plain-Postgres DatabaseProvider. Behavior parity with
 * supabase-db/webhooks.ts, with one deliberate upgrade: deleteWebhook
 * removes deliveries + the webhook in a single transaction (two sequential
 * PostgREST calls in the Supabase impl).
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, throwDbError } from './helpers'

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

const CONVERSATION_KEY_LIST_SELECT = [
  'id',
  'name',
  'key_prefix',
  'role',
  'specific_models',
  'allowed_models',
  'allowed_tools',
  'allowed_locales',
  'custom_instructions',
  'ai_model',
  'rate_limit_per_minute',
  'monthly_message_limit',
  'last_used_at',
  'created_at',
  'revoked_at',
] as const

export function webhookMethods(): WebhookMethods {
  return {
    // ─── Webhooks ───

    async listProjectWebhooks(projectId, workspaceId) {
      try {
        return await getAdmin()
          .selectFrom('webhooks')
          .select(['id', 'name', 'url', 'events', 'active', 'created_at', 'updated_at', 'secret'])
          .where('project_id', '=', projectId)
          .where('workspace_id', '=', workspaceId)
          .orderBy('created_at', 'desc')
          .execute() as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getWebhook(webhookId, options) {
      try {
        let query = getAdmin()
          .selectFrom('webhooks')
          .select(['id', 'url', 'secret', 'active', 'name', 'events', 'workspace_id', 'project_id'])
          .where('id', '=', webhookId)

        if (options?.projectId) query = query.where('project_id', '=', options.projectId)
        if (options?.workspaceId) query = query.where('workspace_id', '=', options.workspaceId)

        const row = await query.executeTakeFirst()
        return (row as DatabaseRow | undefined) ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async updateWebhook(webhookId, projectId, workspaceId, updates) {
      try {
        const row = await getAdmin()
          .updateTable('webhooks')
          .set({ ...updates, updated_at: new Date().toISOString() } as never)
          .where('id', '=', webhookId)
          .where('project_id', '=', projectId)
          .where('workspace_id', '=', workspaceId)
          .returning(['id', 'name', 'url', 'events', 'active', 'created_at', 'updated_at'])
          .executeTakeFirst()

        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return row as DatabaseRow
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async deleteWebhook(webhookId, projectId, workspaceId) {
      // One transaction — deliveries can't orphan if the webhook delete fails
      // (two sequential calls in the PostgREST impl).
      try {
        await getAdmin().transaction().execute(async (trx) => {
          await trx.deleteFrom('webhook_deliveries').where('webhook_id', '=', webhookId).execute()
          await trx.deleteFrom('webhooks')
            .where('id', '=', webhookId)
            .where('project_id', '=', projectId)
            .where('workspace_id', '=', workspaceId)
            .execute()
        })
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listActiveProjectWebhooks(workspaceId, projectId) {
      try {
        return await getAdmin()
          .selectFrom('webhooks')
          .select(['id', 'url', 'events', 'secret', 'active'])
          .where('workspace_id', '=', workspaceId)
          .where('project_id', '=', projectId)
          .where('active', '=', true)
          .execute() as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    // ─── Webhook Deliveries ───

    async createWebhookDelivery(input) {
      try {
        const row = await getAdmin()
          .insertInto('webhook_deliveries')
          .values({
            webhook_id: input.webhookId,
            event: input.event,
            payload: JSON.stringify(input.payload),
            status: 'pending',
          })
          .returning('id')
          .executeTakeFirst()

        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return row as DatabaseRow
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listWebhookDeliveries(webhookId, options) {
      const page = options?.page ?? 1
      const limit = options?.limit ?? 50
      const offset = (page - 1) * limit

      try {
        const base = getAdmin()
          .selectFrom('webhook_deliveries')
          .where('webhook_id', '=', webhookId)

        const totalRow = await base
          .select(eb => eb.fn.countAll().as('total'))
          .executeTakeFirst()

        const rows = await base
          .select(['id', 'event', 'status', 'response_code', 'response_body', 'retry_count', 'delivered_at', 'next_retry_at', 'created_at'])
          .orderBy('created_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute()

        return { deliveries: rows as DatabaseRow[], total: Number(totalRow?.total ?? 0) }
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async updateWebhookDelivery(deliveryId, updates) {
      try {
        await getAdmin()
          .updateTable('webhook_deliveries')
          .set(updates as never)
          .where('id', '=', deliveryId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listPendingWebhookRetries(limit = 50) {
      try {
        return await getAdmin()
          .selectFrom('webhook_deliveries')
          .select(['id', 'webhook_id', 'payload', 'retry_count'])
          .where('status', '=', 'pending')
          .where('next_retry_at', '<=', new Date().toISOString())
          .limit(limit)
          .execute() as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async deleteWebhookDeliveries(webhookId) {
      try {
        await getAdmin()
          .deleteFrom('webhook_deliveries')
          .where('webhook_id', '=', webhookId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    // ─── Conversation API Keys CRUD ───

    async listConversationKeys(projectId, workspaceId) {
      try {
        return await getAdmin()
          .selectFrom('conversation_api_keys')
          .select(CONVERSATION_KEY_LIST_SELECT)
          .where('project_id', '=', projectId)
          .where('workspace_id', '=', workspaceId)
          .orderBy('created_at', 'desc')
          .execute() as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async createConversationKey(input) {
      try {
        const row = await getAdmin()
          .insertInto('conversation_api_keys')
          .values(input as never)
          .returning(['id', 'name', 'key_prefix', 'role', 'specific_models', 'allowed_models', 'allowed_tools', 'allowed_locales', 'custom_instructions', 'ai_model', 'rate_limit_per_minute', 'monthly_message_limit', 'created_at'])
          .executeTakeFirst()

        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return row as DatabaseRow
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async updateConversationKey(keyId, projectId, workspaceId, updates) {
      try {
        const row = await getAdmin()
          .updateTable('conversation_api_keys')
          .set(updates as never)
          .where('id', '=', keyId)
          .where('project_id', '=', projectId)
          .where('workspace_id', '=', workspaceId)
          .returning(['id', 'name', 'role', 'specific_models', 'allowed_models', 'allowed_tools', 'allowed_locales', 'custom_instructions', 'ai_model', 'rate_limit_per_minute', 'monthly_message_limit'])
          .executeTakeFirst()

        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return row as DatabaseRow
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async revokeConversationKey(keyId, projectId, workspaceId) {
      try {
        await getAdmin()
          .updateTable('conversation_api_keys')
          .set({ revoked_at: new Date().toISOString() })
          .where('id', '=', keyId)
          .where('project_id', '=', projectId)
          .where('workspace_id', '=', workspaceId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async countActiveConversationKeys(projectId, workspaceId) {
      try {
        const row = await getAdmin()
          .selectFrom('conversation_api_keys')
          .select(eb => eb.fn.countAll().as('count'))
          .where('project_id', '=', projectId)
          .where('workspace_id', '=', workspaceId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst()

        return Number(row?.count ?? 0)
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getConversationKeyUsage(keyIds, month) {
      if (keyIds.length === 0) return []

      try {
        return await getAdmin()
          .selectFrom('agent_usage')
          .select(['api_key_id', 'message_count'])
          .where('api_key_id', 'in', keyIds)
          .where('month', '=', month)
          .where('source', '=', 'api')
          .execute() as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },
  }
}
