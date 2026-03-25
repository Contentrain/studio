import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

vi.mock('~~/server/utils/agent-types', async () => await import('../../server/utils/agent-types'))
vi.mock('~~/server/utils/agent-state-machine', async () => await import('../../server/utils/agent-state-machine'))
vi.mock('~~/server/utils/agent-context', async () => await import('../../server/utils/agent-context'))

async function loadChatHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/chat.post')).default
}

function createConversationLookupClient(conversationOwned: boolean) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: conversationOwned ? { id: 'conversation-existing' } : null,
              }),
            })),
          })),
        })),
      })),
    })),
  }
}

function createAgentUsageAdmin(rows: Array<{ message_count: number }>) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({ data: rows }),
          })),
        })),
      })),
    })),
  }
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
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue(createAgentUsageAdmin([])))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      project: { id: 'project-1', status: 'active' },
      workspace: { id: 'workspace-1', plan: 'free' },
      git: createGitStub(),
      contentRoot: '',
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('free'))
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
        status: 403,
        message: 'No chat permissions',
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
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue(createAgentUsageAdmin([
      { message_count: 2 },
      { message_count: 1 },
    ])))
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
        status: 429,
        message: 'Monthly message limit reached (3 messages). Upgrade your plan for more.',
      })
    })
  })

  it('starts a fresh conversation when the provided conversation id is not owned by the caller', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    const userClient = createConversationLookupClient(false)
    const createConversation = vi.fn().mockResolvedValue('conversation-new')
    const loadConversationHistory = vi.fn().mockResolvedValue([])
    const saveChatResult = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1', email: 'user@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue(userClient))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      project: { id: 'project-1', status: 'active' },
      workspace: { id: 'workspace-1', plan: 'free' },
      git: createGitStub(),
      contentRoot: '',
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('free'))
    vi.stubGlobal('getMonthlyMessageLimit', vi.fn().mockReturnValue(Infinity))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['get_content'],
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
    vi.stubGlobal('createConversation', createConversation)
    vi.stubGlobal('loadConversationHistory', loadConversationHistory)
    vi.stubGlobal('saveChatResult', saveChatResult)
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({}))
    vi.stubGlobal('buildSystemPrompt', vi.fn().mockReturnValue('system'))
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
      expect(createConversation).toHaveBeenCalledWith(userClient, 'project-1', 'user-1', 'hello')
      expect(loadConversationHistory).toHaveBeenCalledWith(userClient, 'conversation-new', 50)
      expect(saveChatResult).toHaveBeenCalledWith(
        {},
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
      )
    })
  })
})
