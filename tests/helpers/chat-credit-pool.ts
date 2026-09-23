import { vi } from 'vitest'

/**
 * Test harness for the chat route's credit accounting.
 *
 * `createCreditPool` is the workspace AI credit pool with the atomic
 * semantics of the SQL functions: `incrementAgentUsageIfAllowed` (027/030,
 * reserve 1), `reserveAgentCredits` (031, reserve up to the turn ceiling)
 * and a settle that applies its delta. `stubChatRoute` wires the route's
 * globals around it and records every payment-meter event, so a test can
 * assert what reached the payment provider and what the pool holds —
 * against whichever reservation flow the route uses.
 */

export const CHAT_PATH = '/api/workspaces/workspace-1/projects/project-1/chat'

export async function loadChatHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/chat.post')).default
}

export interface SettleInput {
  source: string
  inputTokens: number
  outputTokens: number
  messageCountDelta?: number
}

export function createCreditPool(preUsed: number) {
  const state = { studioTotal: preUsed, settles: [] as SettleInput[] }
  const db = {
    async incrementAgentUsageIfAllowed(input: { source: string, limit: number }) {
      if (input.source !== 'studio') return { allowed: true, currentCount: state.studioTotal }
      if (state.studioTotal >= input.limit) return { allowed: false, currentCount: state.studioTotal }
      state.studioTotal += 1
      return { allowed: true, currentCount: state.studioTotal }
    },
    async reserveAgentCredits(input: { source: string, limit: number, amount: number }) {
      if (input.source !== 'studio') return { allowed: true, granted: 1, currentCount: state.studioTotal }
      if (state.studioTotal >= input.limit) return { allowed: false, granted: 0, currentCount: state.studioTotal }
      const granted = Math.min(Math.max(input.amount, 1), input.limit - state.studioTotal)
      state.studioTotal += granted
      return { allowed: true, granted, currentCount: state.studioTotal }
    },
    async updateAgentUsageTokens(input: SettleInput) {
      if (input.source === 'studio') state.studioTotal += input.messageCountDelta ?? 0
      state.settles.push(input)
    },
    async decrementAgentUsage(input: { source: string }) {
      if (input.source === 'studio') state.studioTotal = Math.max(0, state.studioTotal - 1)
    },
    getConversation: vi.fn().mockResolvedValue({ id: 'conversation-existing' }),
    createConversation: vi.fn().mockResolvedValue('conversation-existing'),
    loadConversationMessages: vi.fn().mockResolvedValue([]),
  }
  return { state, db }
}

export type CreditPool = ReturnType<typeof createCreditPool>

export type StreamFn = (request: { abortSignal?: AbortSignal, maxTokens: number }) => AsyncGenerator<Record<string, unknown>>

export function stubChatRoute(pool: CreditPool, opts: {
  plan: string
  limit: number
  stream: StreamFn
}) {
  const meter: number[] = []
  /** The credit unit each meter event was sent in (picks the Polar meter). */
  const meterUnits: Array<string | undefined> = []
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'workspaceId') return 'workspace-1'
    if (key === 'projectId') return 'project-1'
    return undefined
  }))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'user-1', email: 'user@example.com' }, accessToken: 'token-1' }))
  vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(pool.db))
  vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
    project: { id: 'project-1', status: 'active' },
    workspace: { id: 'workspace-1', plan: opts.plan },
    git: { readFile: vi.fn().mockRejectedValue(new Error('missing')), listDirectory: vi.fn().mockResolvedValue([]), listBranches: vi.fn().mockResolvedValue([]) },
    contentRoot: '',
  }))
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue(opts.plan))
  vi.stubGlobal('getMonthlyMessageLimit', vi.fn().mockReturnValue(opts.limit))
  vi.stubGlobal('getPlanLimit', vi.fn().mockReturnValue(1))
  vi.stubGlobal('getEffectiveLimit', vi.fn((limit: number) => limit))
  vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({ availableTools: ['get_content'], specificModels: false, allowedModels: [] }))
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
  vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
    sessionSecret: 'test-session-secret-32-characters-min',
    anthropic: { apiKey: 'sk-studio' },
    public: { siteUrl: 'http://localhost:3000' },
  }))
  // Mirrors the real saveChatResult: it settles the usage row itself
  // unless the caller opted out (`settleUsage: false`).
  vi.stubGlobal('saveChatResult', vi.fn(async (input: { usageSource: string, inputTokens: number, outputTokens: number, extraMessageCount?: number, settleUsage?: boolean }) => {
    if (input.settleUsage === false) return
    await pool.db.updateAgentUsageTokens({
      source: input.usageSource,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      messageCountDelta: input.extraMessageCount ?? 0,
    })
  }))
  vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({}))
  vi.stubGlobal('buildSystemPromptBlocks', vi.fn().mockReturnValue({ static: 'system', contentIndex: null, dynamic: '' }))
  vi.stubGlobal('toSystemBlocks', vi.fn().mockReturnValue([{ type: 'text', text: 'system' }]))
  vi.stubGlobal('buildContentIndex', vi.fn().mockReturnValue(''))
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: null, models: new Map(), vocabulary: null, contentContext: null }))
  vi.stubGlobal('filterToolsByPermissions', vi.fn().mockReturnValue([]))
  vi.stubGlobal('STUDIO_TOOLS', [])
  vi.stubGlobal('reportBillingRisk', vi.fn())
  vi.stubGlobal('recordAIUsage', vi.fn(async (input: { count: number, creditUnit?: string }) => {
    meter.push(input.count)
    meterUnits.push(input.creditUnit)
  }))
  vi.stubGlobal('useAIProvider', vi.fn().mockReturnValue({ streamCompletion: opts.stream }))
  return { meter, meterUnits }
}

export async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!check() && Date.now() - start < ms) await new Promise(r => setTimeout(r, 20))
}

/** A single heavy call: 1M input + 70K output on Haiku 4.5 = $1.35 = 45 credits. */
export async function* heavyTurn(): AsyncGenerator<Record<string, unknown>> {
  yield { type: 'text', content: 'Done.' }
  yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1_000_000, outputTokens: 70_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }
}
