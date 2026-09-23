import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventHandler } from 'h3'
import type { H3Event } from 'h3'
import { withTestServer } from '../helpers/http'
import { PLAN_LIMITS } from '../../shared/utils/license'
import { getMaxCreditsPerMessage } from '../../shared/utils/ai-credits'

vi.mock('~~/server/utils/agent-types', async () => await import('../../server/utils/agent-types'))
vi.mock('~~/server/utils/agent-state-machine', async () => await import('../../server/utils/agent-state-machine'))
vi.mock('~~/server/utils/agent-context', async () => await import('../../server/utils/agent-context'))
vi.mock('~~/server/utils/agent-system-prompt', async () => await import('../../server/utils/agent-system-prompt'))
vi.mock('~~/server/utils/conversation-engine', async () => await import('../../server/utils/conversation-engine'))
vi.mock('~~/server/utils/conversation-history', async () => await import('../../server/utils/conversation-history'))

const resolveEnterpriseChatApiKey = vi.fn()
vi.mock('../../server/utils/enterprise', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/utils/enterprise')>()),
  resolveEnterpriseChatApiKey: (...args: unknown[]) => resolveEnterpriseChatApiKey(...args),
}))

const OPUS = 'claude-opus-5-5'
const SOFT_CAP = 2_147_483_647
const STARTER_CREDITS = PLAN_LIMITS['ai.messages_per_month']!.values.starter
const PRO_CREDITS = PLAN_LIMITS['ai.messages_per_month']!.values.pro

interface Billing {
  state: string
  trial?: { trialing: boolean, origin: 'migrate' | 'standard' }
}

function stubTurn(opts: { allowed?: boolean, apiUsed?: number } = {}) {
  const allowed = opts.allowed ?? true
  const reserveAgentCredits = vi.fn().mockImplementation(async ({ amount }: { amount: number }) => ({ allowed, granted: allowed ? amount : 0, currentCount: 0 }))
  const recordAIUsage = vi.fn().mockResolvedValue(undefined)
  const models: string[] = []

  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'workspaceId') return 'workspace-1'
    if (key === 'projectId') return 'project-1'
    return undefined
  }))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'user-1', email: 'user@example.com' }, accessToken: 'token-1' }))
  vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
    reserveAgentCredits,
    updateAgentUsageTokens: vi.fn().mockResolvedValue(undefined),
    // API credits already used this period — shared with the chat in a capped trial.
    getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(opts.apiUsed ?? 0),
    getConversation: vi.fn().mockResolvedValue({ id: 'conversation-existing' }),
    createConversation: vi.fn().mockResolvedValue('conversation-existing'),
    loadConversationMessages: vi.fn().mockResolvedValue([]),
  }))
  vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
    project: { id: 'project-1', status: 'active' },
    workspace: { id: 'workspace-1', plan: 'pro' },
    git: { readFile: vi.fn().mockRejectedValue(new Error('missing')), listDirectory: vi.fn().mockResolvedValue([]), listBranches: vi.fn().mockResolvedValue([]) },
    contentRoot: '',
  }))
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
  // Per plan, from the catalog (v2 unit): the trial cap reads Starter's.
  vi.stubGlobal('getMonthlyMessageLimit', vi.fn((plan: string) => PLAN_LIMITS['ai.messages_per_month']!.values[plan as 'starter' | 'pro']))
  vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({ availableTools: ['get_content'], specificModels: false, allowedModels: [] }))
  // Pro plan: `ai.pro_models` on, so Opus is a candidate at all.
  vi.stubGlobal('hasFeature', vi.fn((_: unknown, feature: string) => feature === 'ai.pro_models'))
  vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
    sessionSecret: 'test-session-secret-32-characters-min',
    anthropic: { apiKey: 'sk-studio' },
    public: { siteUrl: 'http://localhost:3000' },
  }))
  vi.stubGlobal('saveChatResult', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({}))
  vi.stubGlobal('buildSystemPromptBlocks', vi.fn().mockReturnValue({ static: 'system', contentIndex: null, dynamic: '' }))
  vi.stubGlobal('toSystemBlocks', vi.fn().mockReturnValue([{ type: 'text', text: 'system' }]))
  vi.stubGlobal('buildContentIndex', vi.fn().mockReturnValue(''))
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: null, models: new Map(), vocabulary: null, contentContext: null }))
  vi.stubGlobal('filterToolsByPermissions', vi.fn().mockReturnValue([]))
  vi.stubGlobal('STUDIO_TOOLS', [])
  vi.stubGlobal('recordAIUsage', recordAIUsage)
  vi.stubGlobal('useAIProvider', vi.fn().mockReturnValue({
    streamCompletion: async function* (request: { model: string }) {
      models.push(request.model)
      yield { type: 'text', content: 'Done.' }
      yield { type: 'message_end', usage: { inputTokens: 10, outputTokens: 10 }, stopReason: 'end_turn' }
    },
  }))

  return { reserveAgentCredits, recordAIUsage, models }
}

async function runTurn(billing: Billing, body: Record<string, unknown> = {}) {
  const inner = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/chat.post')).default
  // Stands in for `03.billing.ts`, which puts this on the context.
  const handler = eventHandler((event: H3Event) => {
    event.context.billing = { effectivePlan: 'pro', overageSettings: { ai_messages: true }, ...billing }
    return inner(event)
  })
  let status = 0
  let payload = ''
  await withTestServer({
    routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/chat', handler }],
  }, async ({ request }) => {
    const response = await request('/api/workspaces/workspace-1/projects/project-1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', conversationId: 'conversation-existing', ...body }),
    })
    status = response.status
    payload = await response.text()
  })
  return { status, payload }
}

const trial = (origin: 'migrate' | 'standard'): Billing => ({ state: 'trial_active', trial: { trialing: true, origin } })
const subscribed: Billing = { state: 'subscribed', trial: { trialing: false, origin: 'migrate' } }

describe('chat route — premium models in a trial', () => {
  beforeEach(() => {
    resolveEnterpriseChatApiKey.mockReset()
    vi.stubGlobal('getPlanLimit', vi.fn().mockReturnValue(1))
    vi.stubGlobal('getEffectiveLimit', vi.fn((limit: number) => limit))
  })

  it('a trial on the Studio key asking for Opus runs on the default model instead', async () => {
    resolveEnterpriseChatApiKey.mockResolvedValue({ apiKey: 'sk-studio', usageSource: 'studio' })
    const turn = stubTurn()
    expect((await runTurn(trial('standard'), { model: OPUS })).status).toBe(200)
    expect(turn.models).toEqual(['claude-sonnet-5'])
  })

  it('a paid subscription gets Opus', async () => {
    resolveEnterpriseChatApiKey.mockResolvedValue({ apiKey: 'sk-studio', usageSource: 'studio' })
    const turn = stubTurn()
    await runTurn(subscribed, { model: OPUS })
    expect(turn.models).toEqual([OPUS])
  })

  it('a trial on its own key (BYOA) keeps Opus — Studio pays nothing for it', async () => {
    resolveEnterpriseChatApiKey.mockResolvedValue({ apiKey: 'sk-user-own', usageSource: 'byoa' })
    const turn = stubTurn()
    await runTurn(trial('standard'), { model: OPUS })
    expect(turn.models).toEqual([OPUS])
  })
})

describe('chat route — trial AI credit cap', () => {
  beforeEach(() => {
    resolveEnterpriseChatApiKey.mockReset()
    resolveEnterpriseChatApiKey.mockResolvedValue({ apiKey: 'sk-studio', usageSource: 'studio' })
    vi.stubGlobal('getPlanLimit', vi.fn().mockReturnValue(1))
    // Overage toggled on: without the cap the reservation would take the soft cap.
    vi.stubGlobal('getEffectiveLimit', vi.fn(() => SOFT_CAP))
  })

  it('a Migrate trial reserves against the Starter allowance, never the overage soft cap', async () => {
    const turn = stubTurn()
    await runTurn(trial('migrate'))
    expect(STARTER_CREDITS).toBeLessThan(PRO_CREDITS)
    expect(turn.reserveAgentCredits).toHaveBeenCalledWith(expect.objectContaining({ limit: STARTER_CREDITS }))
  })

  it('a capped trial reserves a turn at Starter\'s per-message ceiling, not Pro\'s (QA-5 F3)', async () => {
    const turn = stubTurn()
    await runTurn(trial('migrate'))
    expect(turn.reserveAgentCredits).toHaveBeenCalledWith(expect.objectContaining({ amount: getMaxCreditsPerMessage('starter', '0.01') }))

    const paid = stubTurn()
    await runTurn(subscribed)
    expect(paid.reserveAgentCredits).toHaveBeenCalledWith(expect.objectContaining({ amount: getMaxCreditsPerMessage('pro', '0.01') }))
    expect(getMaxCreditsPerMessage('starter', '0.01')).toBeLessThan(getMaxCreditsPerMessage('pro', '0.01'))
  })

  it('the cap lifts with the first payment — the same workspace, subscribed, gets its plan', async () => {
    const turn = stubTurn()
    await runTurn(subscribed)
    expect(turn.reserveAgentCredits).toHaveBeenCalledWith(expect.objectContaining({ limit: SOFT_CAP }))
  })

  it('a standard trial is not capped while the catalog scopes the cap to Migrate trials', async () => {
    const turn = stubTurn()
    await runTurn(trial('standard'))
    expect(turn.reserveAgentCredits).toHaveBeenCalledWith(expect.objectContaining({ limit: SOFT_CAP }))
  })

  it('at the cap the turn is refused with the activation reason and nothing reaches the meter', async () => {
    const turn = stubTurn({ allowed: false })
    const errorMessage = vi.fn((key: string) => key)
    vi.stubGlobal('errorMessage', errorMessage)
    const { status, payload } = await runTurn(trial('migrate'))
    expect(status).toBe(429)
    expect(JSON.parse(payload).data).toMatchObject({ code: 'ai_credits_exhausted', reason: 'trial_cap' })
    // Says how many credits the trial had and what activation opens.
    expect(errorMessage).toHaveBeenCalledWith('chat.trial_credit_cap_reached', { limit: STARTER_CREDITS, fullLimit: PRO_CREDITS })
    expect(turn.models).toEqual([])
    expect(turn.recordAIUsage).not.toHaveBeenCalled()
  })

  it('a capped trial shares one pool between chat and API: AI 200 + API 100 → the 301st credit is refused, unmetered', async () => {
    // Pool = Starter's AI quota (300 in the current unit). With 100 spent on
    // the API, the chat may take 200; the reservation's limit says so, and
    // with AI already at 200 the pool refuses the turn.
    expect(STARTER_CREDITS).toBe(300)
    const turn = stubTurn({ allowed: false, apiUsed: 100 })
    const errorMessage = vi.fn((key: string) => key)
    vi.stubGlobal('errorMessage', errorMessage)
    const { status, payload } = await runTurn(trial('migrate'))
    expect(turn.reserveAgentCredits).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }))
    expect(status).toBe(429)
    expect(JSON.parse(payload).data).toMatchObject({ reason: 'trial_cap' })
    // The message names the whole pool, not what is left of it.
    expect(errorMessage).toHaveBeenCalledWith('chat.trial_credit_cap_reached', { limit: 300, fullLimit: PRO_CREDITS })
    expect(turn.recordAIUsage).not.toHaveBeenCalled()
  })

  it('a normal Pro trial and a paid Pro keep separate pools (no API read, full AI quota)', async () => {
    const turn = stubTurn({ apiUsed: 250 })
    await runTurn(trial('standard'))
    expect(turn.reserveAgentCredits).toHaveBeenCalledWith(expect.objectContaining({ limit: SOFT_CAP }))
  })
})
