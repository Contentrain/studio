import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.hoisted(() => vi.fn(() => ({})))

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}))

describe('supabase client factory', () => {
  beforeEach(() => {
    vi.resetModules()
    createClientMock.mockClear()
    vi.stubGlobal('useRuntimeConfig', () => ({
      supabase: {
        url: 'https://project.supabase.co',
        serviceRoleKey: 'service-role-key',
        anonKey: 'anon-key',
      },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pins the admin client Authorization header to the service-role key', async () => {
    // supabase-js prefers an in-memory auth session's access token over
    // the API key when it builds the PostgREST Authorization header. The
    // explicit global header wins over both, so even if a user session
    // ever lands on the admin client its queries keep service-role
    // privileges instead of silently downgrading to that user's RLS scope.
    const { createSupabaseAdminClient } = await import('../../server/providers/supabase-client')
    createSupabaseAdminClient()

    expect(createClientMock).toHaveBeenCalledWith(
      'https://project.supabase.co',
      'service-role-key',
      expect.objectContaining({
        global: {
          headers: {
            Authorization: 'Bearer service-role-key',
          },
        },
      }),
    )
  })

  it('keeps the auth-flow client a separate singleton from the admin client', async () => {
    const { createSupabaseAdminClient, createSupabaseAuthFlowClient } = await import('../../server/providers/supabase-client')

    createClientMock
      .mockReturnValueOnce({ tag: 'admin' } as never)
      .mockReturnValueOnce({ tag: 'auth-flow' } as never)

    const admin = createSupabaseAdminClient()
    const authFlow = createSupabaseAuthFlowClient()

    expect(admin).not.toBe(authFlow)
    // Both are memoized process-wide singletons.
    expect(createSupabaseAdminClient()).toBe(admin)
    expect(createSupabaseAuthFlowClient()).toBe(authFlow)
    expect(createClientMock).toHaveBeenCalledTimes(2)
  })
})
