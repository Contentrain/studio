import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

vi.mock('~~/server/utils/agent-types', async () => await import('../../server/utils/agent-types'))
vi.mock('~~/server/utils/agent-state-machine', async () => await import('../../server/utils/agent-state-machine'))
vi.mock('~~/server/utils/agent-context', async () => await import('../../server/utils/agent-context'))
vi.mock('~~/server/utils/conversation-engine', async () => await import('../../server/utils/conversation-engine'))

async function loadChatHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/chat.post')).default
}

function createGitStub() {
  return {
    readFile: vi.fn().mockRejectedValue(new Error('missing')),
    listDirectory: vi.fn().mockResolvedValue([]),
    listBranches: vi.fn().mockResolvedValue([]),
  }
}

describe('chat route integration', () => {
  it('returns 403 when the caller has no chat tools', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1', email: 'user@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      project: { id: 'project-1', status: 'active' },
      workspace: { id: 'workspace-1', plan: 'starter' },
      git: createGitStub(),
      contentRoot: '',
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('starter'))
    vi.stubGlobal('getMonthlyMessageLimit', vi.fn().mockReturnValue(Infinity))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: [],
      specificModels: false,
      allowedModels: [],
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/chat', handler: await loadChatHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 403,
      })
    })
  })

  it('enforces the monthly message limit before starting the SSE stream', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1', email: 'user@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      incrementAgentUsageIfAllowed: vi.fn().mockResolvedValue({ allowed: false, currentCount: 3 }),
    }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      project: { id: 'project-1', status: 'active' },
      workspace: { id: 'workspace-1', plan: 'pro' },
      git: createGitStub(),
      contentRoot: '',
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('getMonthlyMessageLimit', vi.fn().mockReturnValue(3))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['get_content'],
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      sessionSecret: 'test-session-secret-32-characters-min',
      anthropic: { apiKey: 'sk-test' },
      public: { siteUrl: 'http://localhost:3000' },
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/chat', handler: await loadChatHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      })

      expect(response.status).toBe(429)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 429,
      })
    })
  })

  it('starts a fresh conversation when the provided conversation id is not owned by the caller', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    const mockCreateConversation = vi.fn().mockResolvedValue('conversation-new')
    const mockLoadMessages = vi.fn().mockResolvedValue([])
    const saveChatResult = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1', email: 'user@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      incrementAgentUsageIfAllowed: vi.fn().mockResolvedValue({ allowed: true, currentCount: 1 }),
      getConversation: vi.fn().mockResolvedValue(null),
      createConversation: mockCreateConversation,
      loadConversationMessages: mockLoadMessages,
    }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      project: { id: 'project-1', status: 'active' },
      workspace: { id: 'workspace-1', plan: 'starter' },
      git: createGitStub(),
      contentRoot: '',
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('starter'))
    vi.stubGlobal('getMonthlyMessageLimit', vi.fn().mockReturnValue(Infinity))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['get_content'],
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
    vi.stubGlobal('saveChatResult', saveChatResult)
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({}))
    vi.stubGlobal('buildSystemPrompt', vi.fn().mockReturnValue('system'))
    vi.stubGlobal('buildContentIndex', vi.fn().mockReturnValue(''))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
      config: null,
      models: new Map(),
      vocabulary: null,
      contentContext: null,
    }))
    vi.stubGlobal('filterToolsByPermissions', vi.fn().mockReturnValue([]))
    vi.stubGlobal('STUDIO_TOOLS', [])
    vi.stubGlobal('useAIProvider', vi.fn().mockReturnValue({
      streamCompletion: async function* () {
        yield { type: 'text', content: 'Hello from the agent.' }
        yield {
          type: 'message_end',
          usage: { inputTokens: 12, outputTokens: 24 },
          stopReason: 'end_turn',
        }
      },
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/chat', handler: await loadChatHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'hello',
          conversationId: 'foreign-conversation',
        }),
      })
      const payload = await response.text()

      expect(response.status).toBe(200)
      expect(payload).toContain('"type":"conversation"')
      expect(payload).toContain('"id":"conversation-new"')
      expect(payload).toContain('"type":"done"')
      expect(mockCreateConversation).toHaveBeenCalledWith('project-1', 'user-1', 'hello')
      expect(mockLoadMessages).toHaveBeenCalledWith('conversation-new', 50)
      expect(saveChatResult).toHaveBeenCalledWith(
        'conversation-new',
        'hello',
        '',
        [],
        expect.any(String),
        12,
        24,
        'workspace-1',
        'user-1',
        'studio',
        expect.any(String),
      )
    })
  })

  it('returns 429 when the request rate limit is exceeded before any AI work starts', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1', email: 'user@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      project: { id: 'project-1', status: 'active' },
      workspace: { id: 'workspace-1', plan: 'starter' },
      git: createGitStub(),
      contentRoot: '',
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('starter'))
    vi.stubGlobal('getMonthlyMessageLimit', vi.fn().mockReturnValue(Infinity))
    vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({
      allowed: false,
      retryAfterMs: 2_000,
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/chat', handler: await loadChatHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      })

      expect(response.status).toBe(429)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 429,
      })
    })
  })

  it('returns 400 when neither a studio key nor a BYOA key is configured', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1', email: 'user@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      project: { id: 'project-1', status: 'active' },
      workspace: { id: 'workspace-1', plan: 'starter' },
      git: createGitStub(),
      contentRoot: '',
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('starter'))
    vi.stubGlobal('getMonthlyMessageLimit', vi.fn().mockReturnValue(Infinity))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['get_content'],
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      sessionSecret: 'test-session-secret-32-characters-min',
      anthropic: { apiKey: '' },
      public: { siteUrl: 'http://localhost:3000' },
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/chat', handler: await loadChatHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 400,
      })
    })
  })

  it('streams an error event when the AI provider crashes mid-request', async () => {
    const saveChatResult = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1', email: 'user@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      incrementAgentUsageIfAllowed: vi.fn().mockResolvedValue({ allowed: true, currentCount: 1 }),
      getConversation: vi.fn().mockResolvedValue({ id: 'conversation-existing' }),
      createConversation: vi.fn().mockResolvedValue('conversation-existing'),
      loadConversationMessages: vi.fn().mockResolvedValue([]),
    }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      project: { id: 'project-1', status: 'active' },
      workspace: { id: 'workspace-1', plan: 'starter' },
      git: createGitStub(),
      contentRoot: '',
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('starter'))
    vi.stubGlobal('getMonthlyMessageLimit', vi.fn().mockReturnValue(Infinity))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['get_content'],
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
    vi.stubGlobal('saveChatResult', saveChatResult)
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({}))
    vi.stubGlobal('buildSystemPrompt', vi.fn().mockReturnValue('system'))
    vi.stubGlobal('buildContentIndex', vi.fn().mockReturnValue(''))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
      config: null,
      models: new Map(),
      vocabulary: null,
      contentContext: null,
    }))
    vi.stubGlobal('filterToolsByPermissions', vi.fn().mockReturnValue([]))
    vi.stubGlobal('STUDIO_TOOLS', [])
    vi.stubGlobal('useAIProvider', vi.fn().mockReturnValue({
      streamCompletion: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw new Error('provider exploded')
            },
          }
        },
      }),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/chat', handler: await loadChatHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'hello',
          conversationId: 'conversation-existing',
        }),
      })
      const payload = await response.text()

      expect(response.status).toBe(200)
      expect(payload).toContain('"type":"conversation"')
      expect(payload).toContain('"type":"error"')
      expect(payload).toContain('provider exploded')
      expect(saveChatResult).not.toHaveBeenCalled()
    })
  })
})
