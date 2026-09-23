import { beforeEach, describe, expect, it, vi } from 'vitest'
import { creditTermsFor } from '../../shared/utils/credit-unit'

/**
 * A key's monthly credit cap never exceeds the workspace's API credits —
 * in the account's own terms. A pre-v2 Pro has 140 $0.03 credits, not the
 * v2 catalog's 450.
 */
const state = vi.hoisted(() => ({
  body: {} as Record<string, unknown>,
  createConversationKey: vi.fn(async (row: Record<string, unknown>) => row),
}))

vi.mock('h3', async () => {
  const actual = await vi.importActual<typeof import('h3')>('h3')
  return {
    ...actual,
    getRouterParam: vi.fn((_: unknown, key: string) => (key === 'workspaceId' ? 'ws-1' : 'proj-1')),
    readBody: vi.fn(async () => state.body),
  }
})
vi.mock('../../server/utils/auth', () => ({ requireAuth: () => ({ user: { id: 'u-1' }, accessToken: 't' }) }))
vi.mock('../../server/utils/content-strings', () => ({ errorMessage: (key: string) => key }))
vi.mock('../../server/utils/license', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/utils/license')>()),
  hasFeature: () => true,
  getPlanLimit: () => 15,
  // The edition lookup reads the deployment; the credit terms are what is under test.
  getCreditLimit: (plan: string, key: 'api.messages_per_month', unit: string) => creditTermsFor(unit).creditLimit(plan, key),
}))
vi.mock('../../server/utils/providers', () => ({
  useDatabaseProvider: () => ({
    requireWorkspaceRole: async () => 'owner',
    getProjectForWorkspace: async () => ({ id: 'proj-1' }),
    getWorkspaceById: async () => ({ plan: 'pro' }),
    countActiveConversationKeys: async () => 0,
    createConversationKey: state.createConversationKey,
  }),
}))

async function create(creditUnit: '0.03' | '0.01', monthlyMessageLimit: number) {
  state.body = { name: 'site bot', monthlyMessageLimit }
  const { createConversationKeysBridge } = await import('../../ee/enterprise/conversation-keys')
  const bridge = createConversationKeysBridge() as unknown as Record<string, (event: unknown) => Promise<Record<string, unknown>>>
  const handler = bridge.createProjectConversationKey!
  return handler({ context: { billing: { effectivePlan: 'pro', creditUnit } } })
}

describe('conversation key credit cap', () => {
  beforeEach(() => state.createConversationKey.mockClear())

  it('caps a pre-v2 Pro key at its own 140 API credits', async () => {
    const key = await create('0.03', 1000)
    expect(key.monthly_message_limit).toBe(140)
  })

  it('caps a v2 Pro key at the catalog\'s 450', async () => {
    const key = await create('0.01', 1000)
    expect(key.monthly_message_limit).toBe(450)
  })
})
