import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Custom AI instructions are their own feature (`api.custom_instructions`).
 * Creating a key checks it the same way updating one does (#437).
 */
const state = vi.hoisted(() => ({
  body: {} as Record<string, unknown>,
  features: new Set<string>(),
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
  hasFeature: (_plan: string, feature: string) => state.features.has(feature),
  getPlanLimit: () => 15,
  getCreditLimit: () => 450,
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

async function create(body: Record<string, unknown>) {
  state.body = body
  const { createConversationKeysBridge } = await import('../../ee/enterprise/conversation-keys')
  const bridge = createConversationKeysBridge() as unknown as Record<string, (event: unknown) => Promise<Record<string, unknown>>>
  return bridge.createProjectConversationKey!({ context: { billing: { effectivePlan: 'pro', creditUnit: '0.01' } } })
}

describe('conversation key create: custom instructions gate', () => {
  beforeEach(() => {
    state.createConversationKey.mockClear()
    state.features = new Set(['api.conversation'])
  })

  it('refuses custom instructions with 403 when the plan lacks api.custom_instructions', async () => {
    await expect(create({ name: 'site bot', customInstructions: 'Be brief.' })).rejects.toMatchObject({
      statusCode: 403,
      message: 'conversation.upgrade',
    })
    expect(state.createConversationKey).not.toHaveBeenCalled()
  })

  it('still creates a key without instructions when the plan lacks the feature', async () => {
    const key = await create({ name: 'site bot' })
    expect(key.custom_instructions).toBeNull()
  })

  it('stores custom instructions when the plan has the feature', async () => {
    state.features.add('api.custom_instructions')
    const key = await create({ name: 'site bot', customInstructions: 'Be brief.' })
    expect(key.custom_instructions).toBe('Be brief.')
  })
})
