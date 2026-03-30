import type { EnterpriseBridge } from '../../server/utils/enterprise'
import { createCloudflareR2Provider } from '../cdn/cloudflare-cdn'
import { trackCDNUsage } from '../cdn/cdn-usage'
import { createSharpMediaProvider } from '../media/sharp-processor'
import { normalizeProjectMemberAccess } from './access'
import { createAiKeysBridge, resolveEnterpriseChatApiKey } from './ai-keys'
import { createConversationApiBridge } from './conversation-api'
import { createConversationKeysBridge } from './conversation-keys'
import { emitWebhookEvent, processWebhookRetries } from './webhook-dispatch'
import { createWebhooksBridge } from './webhooks'

export function createEnterpriseBridge(): EnterpriseBridge {
  return {
    createCDNProvider: createCloudflareR2Provider,
    createMediaProvider: createSharpMediaProvider,
    trackCDNUsage,
    emitWebhookEvent,
    processWebhookRetries,
    normalizeProjectMemberAccess,
    resolveChatApiKey: resolveEnterpriseChatApiKey,
    ...createAiKeysBridge(),
    ...createConversationKeysBridge(),
    ...createWebhooksBridge(),
    ...createConversationApiBridge(),
  }
}
