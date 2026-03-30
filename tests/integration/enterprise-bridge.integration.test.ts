import { afterEach, describe, expect, it, vi } from 'vitest'
import { setEnterpriseBridgeForTesting } from '../../server/utils/enterprise'

async function loadAiKeysListHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/ai-keys/index.get')).default
}

async function loadAiKeysCreateHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/ai-keys/index.post')).default
}

async function loadWebhookCreateHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/webhooks/index.post')).default
}

async function loadConversationKeyCreateHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/conversation-keys/index.post')).default
}

async function loadConversationHistoryHandler() {
  return (await import('../../server/api/conversation/v1/[projectId]/history.get')).default
}

async function loadConversationMessageHandler() {
  return (await import('../../server/api/conversation/v1/[projectId]/message.post')).default
}

function createBridge() {
  return {
    listWorkspaceAiKeys: vi.fn().mockResolvedValue([{ id: 'ai-key-1' }]),
    createWorkspaceAiKey: vi.fn().mockResolvedValue({ id: 'ai-key-2' }),
    deleteWorkspaceAiKey: vi.fn().mockResolvedValue({ deleted: true }),
    listProjectWebhooks: vi.fn().mockResolvedValue([{ id: 'webhook-1' }]),
    createProjectWebhook: vi.fn().mockResolvedValue({ id: 'webhook-2' }),
    updateProjectWebhook: vi.fn().mockResolvedValue({ id: 'webhook-3' }),
    deleteProjectWebhook: vi.fn().mockResolvedValue({ deleted: true }),
    testProjectWebhook: vi.fn().mockResolvedValue({ success: true, statusCode: 200, responseBody: 'ok' }),
    listWebhookDeliveries: vi.fn().mockResolvedValue({ deliveries: [], total: 0, page: 1, limit: 50 }),
    listProjectConversationKeys: vi.fn().mockResolvedValue([{ id: 'conv-key-1' }]),
    createProjectConversationKey: vi.fn().mockResolvedValue({ id: 'conv-key-2', key: 'crn_conv_test' }),
    updateProjectConversationKey: vi.fn().mockResolvedValue({ id: 'conv-key-3' }),
    deleteProjectConversationKey: vi.fn().mockResolvedValue({ revoked: true }),
    handleConversationApiHistory: vi.fn().mockResolvedValue({ conversationId: 'conv-1', messages: [{ id: 'msg-1' }] }),
    handleConversationApiMessage: vi.fn().mockResolvedValue({ conversationId: 'conv-1', message: 'hello' }),
  }
}

describe('enterprise bridge', () => {
  afterEach(() => {
    setEnterpriseBridgeForTesting(undefined)
  })

  it('returns the premium upgrade response when no enterprise bridge is present', async () => {
    setEnterpriseBridgeForTesting(null)
    const handler = await loadAiKeysListHandler()

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it.each([
    {
      name: 'AI key list route',
      loader: loadAiKeysListHandler,
      bridgeMethod: 'listWorkspaceAiKeys' as const,
      expected: [{ id: 'ai-key-1' }],
    },
    {
      name: 'AI key create route',
      loader: loadAiKeysCreateHandler,
      bridgeMethod: 'createWorkspaceAiKey' as const,
      expected: { id: 'ai-key-2' },
    },
    {
      name: 'webhook create route',
      loader: loadWebhookCreateHandler,
      bridgeMethod: 'createProjectWebhook' as const,
      expected: { id: 'webhook-2' },
    },
    {
      name: 'conversation key create route',
      loader: loadConversationKeyCreateHandler,
      bridgeMethod: 'createProjectConversationKey' as const,
      expected: { id: 'conv-key-2', key: 'crn_conv_test' },
    },
    {
      name: 'conversation history route',
      loader: loadConversationHistoryHandler,
      bridgeMethod: 'handleConversationApiHistory' as const,
      expected: { conversationId: 'conv-1', messages: [{ id: 'msg-1' }] },
    },
    {
      name: 'conversation message route',
      loader: loadConversationMessageHandler,
      bridgeMethod: 'handleConversationApiMessage' as const,
      expected: { conversationId: 'conv-1', message: 'hello' },
    },
  ])('$name delegates to the enterprise bridge', async ({ loader, bridgeMethod, expected }) => {
    const bridge = createBridge()
    setEnterpriseBridgeForTesting(bridge)

    const handler = await loader()

    await expect(handler({
    } as never)).resolves.toEqual(expected)
    expect(bridge[bridgeMethod]).toHaveBeenCalledOnce()
  })
})
