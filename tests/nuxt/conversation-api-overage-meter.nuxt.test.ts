import { defineEventHandler } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { withTestServer } from '../helpers/http'

/**
 * MG-12 D1 — the Conversation API counterpart of BR-11 P0-1: with overage
 * OFF, API usage past the plan's included API credits must never reach the
 * payment meter. With overage ON the call is metered in full.
 *
 * The API route reserves 1 credit and settles `credits - 1` at the end; the
 * old code metered both in full, so a call started with 1 credit left sent
 * up to the per-message cap to `api_credits` — billed overage.
 */

const state = vi.hoisted(() => ({
  workspaceApiUsage: 0,
  usageReadFails: false,
  usageReadsZero: false,
  overage: false,
  modelCalls: 0,
  meter: [] as number[],
}))

// The Conversation API module reads `useRuntimeConfig` from `#imports`,
// which only resolves in the Nuxt test environment — hence a .nuxt test.
mockNuxtImport('useRuntimeConfig', original => () => ({ ...original(), anthropic: { apiKey: 'sk-studio' } }))
vi.mock('../../server/utils/conversation-keys', () => ({
  validateConversationKey: async () => ({
    keyId: 'key-1',
    name: 'site bot',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    role: 'viewer',
    allowedTools: [],
    specificModels: false,
    allowedModels: [],
    allowedLocales: [],
    customInstructions: null,
    rateLimitPerMinute: 60,
    monthlyMessageLimit: 1000,
    aiModel: 'claude-haiku-4-5-20251001',
  }),
}))
vi.mock('../../server/utils/providers', () => ({
  useDatabaseProvider: () => ({
    getProjectById: async () => ({ id: 'project-1', repo_full_name: 'acme/site', content_root: '', workspace_id: 'workspace-1', status: 'active' }),
    getWorkspaceById: async () => ({ id: 'workspace-1', github_installation_id: 1, plan: 'pro' }),
    // 006 semantics: the workspace total is checked against the (effective)
    // workspace limit, then this call's credit is reserved.
    incrementAPIUsageIfAllowed: async (input: { workspaceLimit: number }) => {
      if (state.workspaceApiUsage >= input.workspaceLimit) return { allowed: false, reason: 'workspace_limit', current: state.workspaceApiUsage }
      state.workspaceApiUsage += 1
      return { allowed: true, reason: 'ok', current: state.workspaceApiUsage }
    },
    getWorkspaceMonthlyAPIUsage: async () => {
      if (state.usageReadFails) throw new Error('connection reset')
      // What the postgres and supabase readers return when their query fails.
      if (state.usageReadsZero) return 0
      return state.workspaceApiUsage
    },
    decrementAPIUsage: async () => { state.workspaceApiUsage -= 1 },
    getConversation: async () => null,
    createApiConversation: async () => 'conversation-1',
    loadConversationMessages: async () => [],
  }),
  useGitProvider: () => ({ listBranches: async () => [] }),
}))
vi.mock('../../server/utils/brain-cache', () => ({
  getOrBuildBrainCache: async () => ({ config: null, models: new Map(), vocabulary: null, contentContext: null }),
  buildContentIndex: () => '',
}))
vi.mock('../../server/utils/content-engine', () => ({ createContentEngine: () => ({}) }))
vi.mock('../../server/utils/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterMs: 0 }) }))
vi.mock('../../server/utils/usage-period', () => ({ resolveUsagePeriod: async () => ({ key: '2026-09', resetsAt: '2026-10-01T00:00:00.000Z' }) }))
vi.mock('../../server/utils/db', () => ({ saveApiChatResult: async () => {} }))
// Plan and overage as the billing resolver (#337) reports them; the API
// feature gate is an EE flag the test environment does not carry.
vi.mock('../../server/utils/workspace-billing', () => ({
  // A pre-v2 subscription: $0.03 credits, Pro 140 API (credit-unit.ts).
  resolveWorkspaceBilling: async () => ({ state: 'subscribed', effectivePlan: 'pro', overageSettings: { api_messages: state.overage }, creditUnit: '0.03' }),
}))
vi.mock('../../server/utils/license', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/utils/license')>()),
  hasFeature: () => true,
}))
vi.mock('../../server/utils/alert', () => ({ reportBillingRisk: () => {} }))
// The prompt builder is not under test and reads server-only content globals.
vi.mock('../../server/utils/agent-system-prompt', () => ({
  buildSystemPromptBlocks: () => ({ static: 'system', contentIndex: null, dynamic: '' }),
  toSystemBlocks: () => [{ type: 'text', text: 'system' }],
  buildRequestContext: () => '',
}))

async function sendApiMessage(opts: { overage: boolean }): Promise<number> {
  state.overage = opts.overage
  const { createConversationApiBridge } = await import('../../ee/enterprise/conversation-api')
  const bridge = createConversationApiBridge()
  let status = 0
  const billing = defineEventHandler((event) => {
    // The real route is `/api/conversation/v1/[projectId]/message`.
    event.context.params = { projectId: 'project-1' }
  })
  await withTestServer({
    middleware: [billing],
    routes: [{ path: '/api/conversation/v1/project-1/message', handler: defineEventHandler(event => bridge.handleConversationApiMessage(event)) }],
  }, async ({ request }) => {
    const response = await request('/api/conversation/v1/project-1/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer crk_test' },
      body: JSON.stringify({ message: 'summarise the FAQ' }),
    })
    status = response.status
    await response.text()
  })
  return status
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

describe('Conversation API — the payment meter respects overage off (MG-12 D1)', () => {
  beforeEach(() => {
    // Server auto-imports the conversation engine uses (not present in the
    // Nuxt app environment).
    vi.stubGlobal('emptyAffected', () => ({ models: [], locales: [], snapshotChanged: false, branchesChanged: false }))
    vi.stubGlobal('mergeAffected', (a: unknown) => a)
    state.meter = []
    state.modelCalls = 0
    state.usageReadFails = false
    state.usageReadsZero = false
    vi.stubGlobal('recordAPIUsage', vi.fn(async (input: { count: number }) => {
      state.meter.push(input.count)
    }))
    // One heavy call: 1M input + 70K output on Haiku 4.5 = $1.35 = 45 credits.
    vi.stubGlobal('useAIProvider', vi.fn().mockReturnValue({
      streamCompletion: async function* () {
        state.modelCalls++
        yield { type: 'text', content: 'Here is the summary.' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1_000_000, outputTokens: 70_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }
      },
    }))
  })

  it('overage off, one included API credit left: a 45-credit call meters exactly that one', async () => {
    // Pro includes 140 API credits; 139 are used.
    state.workspaceApiUsage = 139

    expect(await sendApiMessage({ overage: false })).toBe(200)
    // Before the fix: 1 on the first event + 44 at the settle = 45.
    expect(sum(state.meter)).toBe(1)
  })

  it('overage off, allowance used up: refused, nothing metered', async () => {
    state.workspaceApiUsage = 140

    expect(await sendApiMessage({ overage: false })).toBe(429)
    expect(state.meter).toEqual([])
  })

  it('overage on, past the allowance: metered in full', async () => {
    state.workspaceApiUsage = 200

    expect(await sendApiMessage({ overage: true })).toBe(200)
    expect(sum(state.meter)).toBe(45)
  })

  it('overage off and the usage read fails: refused before any model call, reservation refunded', async () => {
    // QA-2: the cap must fail closed. Metering blind could bill overage the
    // workspace switched off.
    state.workspaceApiUsage = 10
    state.usageReadFails = true

    expect(await sendApiMessage({ overage: false })).toBe(503)
    expect(state.modelCalls).toBe(0)
    expect(state.meter).toEqual([])
    expect(state.workspaceApiUsage).toBe(10)
  })

  it('overage off and the usage read swallows its error (returns 0): refused, refunded, nothing metered', async () => {
    // QA-4: getWorkspaceMonthlyAPIUsage catches its own errors and returns 0
    // in both providers. After the reservation the total is at least 1, so 0
    // means the read failed; treated as a total, it would open an allowance
    // of the whole plan and meter this 45-credit call in full.
    state.workspaceApiUsage = 139
    state.usageReadsZero = true

    expect(await sendApiMessage({ overage: false })).toBe(503)
    expect(state.modelCalls).toBe(0)
    expect(state.meter).toEqual([])
    expect(state.workspaceApiUsage).toBe(139)
  })
})
