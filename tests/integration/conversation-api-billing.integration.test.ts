import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Conversation API sits outside `/api/workspaces/*`, so the billing
 * middleware never runs on it. It used to gate on the raw `workspaces.plan`
 * column and read overage from `event.context.billing` — which is never set
 * there, so overage could not be enabled at all, and an expired trial kept
 * Pro limits. It now resolves both through `resolveWorkspaceBilling`.
 *
 * The run stops at the quota reservation (refused), which is where plan and
 * overage are consumed.
 */

const state = vi.hoisted(() => ({
  effectivePlan: 'pro' as string,
  billingOverage: {} as Record<string, boolean>,
  workspaceRow: { id: 'ws-1', github_installation_id: 42, type: 'primary', plan: 'pro', overage_settings: { api_messages: true } },
  incrementAPIUsageIfAllowed: vi.fn(),
  getEffectiveLimit: vi.fn((limit: number) => limit),
  hasFeature: vi.fn((plan: string) => plan !== 'free'),
}))

vi.mock('h3', async () => {
  const actual = await vi.importActual<typeof import('h3')>('h3')
  return {
    ...actual,
    readBody: vi.fn(async () => ({ message: 'hello' })),
    getHeader: vi.fn(() => 'Bearer crn_conv_test'),
    getRouterParam: vi.fn(() => 'proj-1'),
  }
})
vi.mock('#imports', () => ({ useRuntimeConfig: () => ({ public: { siteUrl: '' } }) }))
vi.mock('../../server/utils/conversation-keys', () => ({
  validateConversationKey: vi.fn(async () => ({
    keyId: 'key-1',
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    monthlyMessageLimit: 1000,
    rateLimitPerMinute: 10,
    aiModel: 'claude-sonnet-5',
  })),
}))
vi.mock('../../server/utils/providers', () => ({
  useDatabaseProvider: () => ({
    getProjectById: vi.fn(async () => ({ id: 'proj-1', workspace_id: 'ws-1', repo_full_name: 'o/r', content_root: '' })),
    getWorkspaceById: vi.fn(async () => state.workspaceRow),
    incrementAPIUsageIfAllowed: state.incrementAPIUsageIfAllowed,
    decrementAPIUsage: vi.fn(),
  }),
  useGitProvider: vi.fn(),
}))
vi.mock('../../server/utils/workspace-billing', () => ({
  resolveWorkspaceBilling: vi.fn(async () => ({ state: 'subscribed', effectivePlan: state.effectivePlan, overageSettings: state.billingOverage })),
}))
vi.mock('../../server/utils/license', () => ({
  getWorkspacePlan: vi.fn(() => 'pro'),
  hasFeature: state.hasFeature,
  getPlanLimit: vi.fn(() => 140),
}))
vi.mock('../../server/utils/overage', () => ({ getEffectiveLimit: state.getEffectiveLimit }))
vi.mock('../../server/utils/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, retryAfterMs: 0 })) }))
vi.mock('../../server/utils/usage-period', () => ({ resolveUsagePeriod: vi.fn(async () => ({ key: '2026-09-29', resetsAt: '2026-10-29T00:00:00.000Z' })) }))
vi.mock('../../server/utils/content-strings', () => ({ errorMessage: (key: string) => key }))

async function send() {
  const { createConversationApiBridge } = await import('../../ee/enterprise/conversation-api')
  return createConversationApiBridge().handleConversationApiMessage({ context: {} } as never)
}

describe('Conversation API — plan and overage come from billing', () => {
  beforeEach(() => {
    state.effectivePlan = 'pro'
    state.billingOverage = {}
    state.hasFeature.mockClear()
    state.getEffectiveLimit.mockClear()
    state.incrementAPIUsageIfAllowed.mockReset().mockResolvedValue({ allowed: false, reason: 'workspace_limit' })
  })

  it('gates on the billing-derived plan, not the workspace column', async () => {
    // The row still says pro; the trial expired, so billing says free.
    state.effectivePlan = 'free'
    await expect(send()).rejects.toMatchObject({ statusCode: 403, message: 'conversation.upgrade' })
    expect(state.hasFeature).toHaveBeenCalledWith('free', 'api.conversation')
    expect(state.incrementAPIUsageIfAllowed).not.toHaveBeenCalled()
  })

  it('reads overage from the workspace through billing, so the toggle takes effect', async () => {
    state.billingOverage = { api_messages: true }
    await expect(send()).rejects.toMatchObject({ statusCode: 429 })
    expect(state.getEffectiveLimit).toHaveBeenCalledWith(140, 'api.messages_per_month', { api_messages: true })
  })

  it('does not raise the cap on a toggle the subscription cannot bill', async () => {
    // Row has the toggle on; billing turned it off (trial / legacy prices).
    state.billingOverage = { api_messages: false }
    await expect(send()).rejects.toMatchObject({ statusCode: 429 })
    expect(state.getEffectiveLimit).toHaveBeenCalledWith(140, 'api.messages_per_month', { api_messages: false })
  })
})
