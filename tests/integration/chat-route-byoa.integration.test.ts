import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

vi.mock('~~/server/utils/agent-types', async () => await import('../../server/utils/agent-types'))
vi.mock('~~/server/utils/agent-state-machine', async () => await import('../../server/utils/agent-state-machine'))
vi.mock('~~/server/utils/agent-context', async () => await import('../../server/utils/agent-context'))
vi.mock('~~/server/utils/agent-system-prompt', async () => await import('../../server/utils/agent-system-prompt'))
vi.mock('~~/server/utils/conversation-engine', async () => await import('../../server/utils/conversation-engine'))
vi.mock('~~/server/utils/conversation-history', async () => await import('../../server/utils/conversation-history'))

// Which key the turn runs on is the one input these tests vary.
const resolveEnterpriseChatApiKey = vi.fn()
vi.mock('../../server/utils/enterprise', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/utils/enterprise')>()),
  resolveEnterpriseChatApiKey: (...args: unknown[]) => resolveEnterpriseChatApiKey(...args),
}))

async function loadChatHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/chat.post')).default
}

function stubTurn(opts: { plan: string, monthlyLimit: number }) {
  const incrementAgentUsageIfAllowed = vi.fn().mockResolvedValue({ allowed: true, currentCount: 0 })
  const recordAIUsage = vi.fn().mockResolvedValue(undefined)
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
    incrementAgentUsageIfAllowed,
    decrementAgentUsage: vi.fn().mockResolvedValue(undefined),
    getConversation: vi.fn().mockResolvedValue({ id: 'conversation-existing' }),
    createConversation: vi.fn().mockResolvedValue('conversation-existing'),
    loadConversationMessages: vi.fn().mockResolvedValue([]),
  }))
  vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
    project: { id: 'project-1', status: 'active' },
    workspace: { id: 'workspace-1', plan: opts.plan },
    git: { readFile: vi.fn().mockRejectedValue(new Error('missing')), listDirectory: vi.fn().mockResolvedValue([]), listBranches: vi.fn().mockResolvedValue([]) },
    contentRoot: '',
  }))
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue(opts.plan))
  vi.stubGlobal('getMonthlyMessageLimit', vi.fn().mockReturnValue(opts.monthlyLimit))
  vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
    availableTools: ['get_content'],
    specificModels: false,
    allowedModels: [],
  }))
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
  vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
    sessionSecret: 'test-session-secret-32-characters-min',
    anthropic: { apiKey: 'sk-studio' },
    public: { siteUrl: 'http://localhost:3000' },
  }))
  vi.stubGlobal('saveChatResult', saveChatResult)
  vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({}))
  vi.stubGlobal('buildSystemPromptBlocks', vi.fn().mockReturnValue({ static: 'system', contentIndex: null, dynamic: '' }))
  vi.stubGlobal('toSystemBlocks', vi.fn().mockReturnValue([{ type: 'text', text: 'system' }]))
  vi.stubGlobal('buildContentIndex', vi.fn().mockReturnValue(''))
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
    config: null,
    models: new Map(),
    vocabulary: null,
    contentContext: null,
  }))
  vi.stubGlobal('filterToolsByPermissions', vi.fn().mockReturnValue([]))
  vi.stubGlobal('STUDIO_TOOLS', [])
  vi.stubGlobal('recordAIUsage', recordAIUsage)
  vi.stubGlobal('useAIProvider', vi.fn().mockReturnValue({
    streamCompletion: async function* () {
      yield { type: 'text', content: 'Done.' }
      // Heavy enough that a Studio-key turn would settle extra credits.
      yield { type: 'message_end', usage: { inputTokens: 400_000, outputTokens: 60_000 }, stopReason: 'end_turn' }
    },
  }))

  return { incrementAgentUsageIfAllowed, recordAIUsage, saveChatResult }
}

async function runTurn() {
  await withTestServer({
    routes: [
      { path: '/api/workspaces/workspace-1/projects/project-1/chat', handler: await loadChatHandler() },
    ],
  }, async ({ request }) => {
    const response = await request('/api/workspaces/workspace-1/projects/project-1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', conversationId: 'conversation-existing' }),
    })
    expect(response.status).toBe(200)
    await response.text()
  })
}

describe('chat route — BYOA turns are outside the AI credit quota and never metered', () => {
  beforeEach(() => {
    resolveEnterpriseChatApiKey.mockReset()
    vi.stubGlobal('getPlanLimit', vi.fn().mockReturnValue(1))
    vi.stubGlobal('getEffectiveLimit', vi.fn((limit: number) => limit))
  })

  it('a BYOA turn books its row as byoa and sends nothing to the payment meter', async () => {
    resolveEnterpriseChatApiKey.mockResolvedValue({ apiKey: 'sk-user-own', usageSource: 'byoa' })
    const { incrementAgentUsageIfAllowed, recordAIUsage, saveChatResult } = stubTurn({ plan: 'pro', monthlyLimit: 350 })

    await runTurn()

    // Row booked under `byoa` — migration 030 keeps it out of the pool.
    expect(incrementAgentUsageIfAllowed).toHaveBeenCalledWith(expect.objectContaining({ source: 'byoa' }))
    // Neither the base event nor a credit top-up reaches the meter.
    expect(recordAIUsage).not.toHaveBeenCalled()
    expect(saveChatResult).toHaveBeenCalledWith(expect.objectContaining({ usageSource: 'byoa', extraMessageCount: 0 }))
  })

  it('a Studio-key turn is reserved and metered as before', async () => {
    resolveEnterpriseChatApiKey.mockResolvedValue({ apiKey: 'sk-studio', usageSource: 'studio' })
    const { incrementAgentUsageIfAllowed, recordAIUsage } = stubTurn({ plan: 'pro', monthlyLimit: 350 })

    await runTurn()

    expect(incrementAgentUsageIfAllowed).toHaveBeenCalledWith(expect.objectContaining({ source: 'studio', limit: 350 }))
    // Base credit on the first provider event, then the credit-weighted top-up.
    expect(recordAIUsage).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }))
    expect(recordAIUsage.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('on an unlimited plan only Studio-key turns are metered', async () => {
    resolveEnterpriseChatApiKey.mockResolvedValue({ apiKey: 'sk-user-own', usageSource: 'byoa' })
    const byoa = stubTurn({ plan: 'enterprise', monthlyLimit: Infinity })
    await runTurn()
    expect(byoa.recordAIUsage).not.toHaveBeenCalled()

    resolveEnterpriseChatApiKey.mockResolvedValue({ apiKey: 'sk-studio', usageSource: 'studio' })
    const studio = stubTurn({ plan: 'enterprise', monthlyLimit: Infinity })
    await runTurn()
    expect(studio.recordAIUsage).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }))
  })
})
