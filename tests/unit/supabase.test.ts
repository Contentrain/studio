import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const supabaseState = vi.hoisted(() => ({
  createClient: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: supabaseState.createClient,
}))

describe('supabase helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    supabaseState.createClient.mockReset()
    vi.stubGlobal('useRuntimeConfig', () => ({
      supabase: {
        url: 'https://supabase.example.com',
        serviceRoleKey: 'service-role-key',
        anonKey: 'anon-key',
      },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('caches the admin client and disables auth persistence', async () => {
    const adminClient = { admin: true }
    supabaseState.createClient.mockReturnValue(adminClient)

    const { useSupabaseAdmin } = await import('../../server/utils/supabase')

    expect(useSupabaseAdmin()).toBe(adminClient)
    expect(useSupabaseAdmin()).toBe(adminClient)
    expect(supabaseState.createClient).toHaveBeenCalledTimes(1)
    expect(supabaseState.createClient).toHaveBeenCalledWith(
      'https://supabase.example.com',
      'service-role-key',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    )
  })

  it('creates user-scoped clients with bearer auth headers', async () => {
    const userClient = { user: true }
    supabaseState.createClient.mockReturnValue(userClient)

    const { useSupabaseUserClient } = await import('../../server/utils/supabase')

    expect(useSupabaseUserClient('token-123')).toBe(userClient)
    expect(supabaseState.createClient).toHaveBeenCalledWith(
      'https://supabase.example.com',
      'anon-key',
      {
        global: {
          headers: {
            Authorization: 'Bearer token-123',
          },
        },
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    )
  })
})
