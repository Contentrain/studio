import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const providerState = vi.hoisted(() => ({
  databaseProvider: {
    getAdminClient: vi.fn(),
    getUserClient: vi.fn(),
  },
}))

vi.mock('../../server/utils/providers', () => ({
  useDatabaseProvider: vi.fn(() => providerState.databaseProvider),
}))

describe('supabase helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    providerState.databaseProvider.getAdminClient.mockReset()
    providerState.databaseProvider.getUserClient.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delegates admin access through the database provider bridge', async () => {
    const adminClient = { admin: true }
    providerState.databaseProvider.getAdminClient.mockReturnValue(adminClient)

    const { useSupabaseAdmin } = await import('../../server/utils/supabase')

    expect(useSupabaseAdmin()).toBe(adminClient)
    expect(providerState.databaseProvider.getAdminClient).toHaveBeenCalledTimes(1)
  })

  it('delegates user-scoped access through the database provider bridge', async () => {
    const userClient = { user: true }
    providerState.databaseProvider.getUserClient.mockReturnValue(userClient)

    const { useSupabaseUserClient } = await import('../../server/utils/supabase')

    expect(useSupabaseUserClient('token-123')).toBe(userClient)
    expect(providerState.databaseProvider.getUserClient).toHaveBeenCalledWith('token-123')
  })
})
