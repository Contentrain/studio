/**
 * Stub methods for DatabaseProvider.
 *
 * These will be replaced with real implementations as each domain
 * is migrated (Faz 4: Enterprise). Each stub throws so any premature
 * call is caught immediately during development.
 */
import type { DatabaseProvider } from '../database'

type StubMethods = Pick<
  DatabaseProvider,
  // Webhooks extras
  | 'listProjectWebhooks'
  | 'getWebhook'
  | 'updateWebhook'
  | 'deleteWebhook'
  | 'listActiveProjectWebhooks'
  // Webhook Deliveries
  | 'createWebhookDelivery'
  | 'listWebhookDeliveries'
  | 'updateWebhookDelivery'
  | 'listPendingWebhookRetries'
  | 'deleteWebhookDeliveries'
  // Conversation API Keys (CRUD — ee/ only)
  | 'listConversationKeys'
  | 'createConversationKey'
  | 'updateConversationKey'
  | 'revokeConversationKey'
  | 'countActiveConversationKeys'
  | 'getConversationKeyUsage'
>

function stub(name: string): never {
  throw new Error(`Not yet implemented: ${name}`)
}

export function stubMethods(): StubMethods {
  return {
    // Webhooks extras (ee/ only — Faz 4)
    async listProjectWebhooks() { stub('listProjectWebhooks') },
    async getWebhook() { stub('getWebhook') },
    async updateWebhook() { stub('updateWebhook') },
    async deleteWebhook() { stub('deleteWebhook') },
    async listActiveProjectWebhooks() { stub('listActiveProjectWebhooks') },
    // Webhook Deliveries (ee/ only — Faz 4)
    async createWebhookDelivery() { stub('createWebhookDelivery') },
    async listWebhookDeliveries() { stub('listWebhookDeliveries') },
    async updateWebhookDelivery() { stub('updateWebhookDelivery') },
    async listPendingWebhookRetries() { stub('listPendingWebhookRetries') },
    async deleteWebhookDeliveries() { stub('deleteWebhookDeliveries') },
    // Conversation API Keys CRUD (ee/ only — Faz 4)
    async listConversationKeys() { stub('listConversationKeys') },
    async createConversationKey() { stub('createConversationKey') },
    async updateConversationKey() { stub('updateConversationKey') },
    async revokeConversationKey() { stub('revokeConversationKey') },
    async countActiveConversationKeys() { stub('countActiveConversationKeys') },
    async getConversationKeyUsage() { stub('getConversationKeyUsage') },
  }
}
