import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const providerState = vi.hoisted(() => {
  const state = {
    adminClient: {} as Record<string, unknown>,
    createSupabaseAdminClient: vi.fn(() => state.adminClient),
  }

  return state
})

vi.mock('../../server/providers/supabase-db', () => ({
  createSupabaseAdminClient: providerState.createSupabaseAdminClient,
}))

describe('supabase auth provider', () => {
  beforeEach(() => {
    vi.resetModules()
    providerState.adminClient = {}
    providerState.createSupabaseAdminClient.mockClear()
    vi.stubGlobal('createError', ({ statusCode, message }: { statusCode: number, message: string }) =>
      Object.assign(new Error(message), { statusCode, message }),
    )
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {
        siteUrl: 'http://localhost:3000',
      },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('maps validated Supabase users to the AuthUser shape', async () => {
    providerState.adminClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: 'user-1',
              email: 'user@example.com',
              app_metadata: { provider: 'github' },
              user_metadata: {
                avatar_url: 'https://example.com/avatar.png',
                provider_id: '123',
              },
            },
          },
          error: null,
        }),
      },
    }

    const { createSupabaseAuthProvider } = await import('../../server/providers/supabase-auth')
    const provider = createSupabaseAuthProvider()

    await expect(provider.validateToken('token-1')).resolves.toEqual({
      id: 'user-1',
      email: 'user@example.com',
      avatarUrl: 'https://example.com/avatar.png',
      provider: 'github',
      providerAccountId: '123',
    })
  })

  it('refreshes sessions and preserves Supabase expiry timestamps', async () => {
    providerState.adminClient = {
      auth: {
        refreshSession: vi.fn().mockResolvedValue({
          data: {
            session: {
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_at: 1700000000,
            },
          },
          error: null,
        }),
      },
    }

    const { createSupabaseAuthProvider } = await import('../../server/providers/supabase-auth')
    const provider = createSupabaseAuthProvider()

    await expect(provider.refreshSession('refresh-1')).resolves.toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: 1700000000,
    })
  })

  it('builds OAuth redirect URLs and returns a CSRF state token', async () => {
    providerState.adminClient = {
      auth: {
        signInWithOAuth: vi.fn().mockResolvedValue({
          data: {
            url: 'https://supabase.example.com/auth/v1/authorize',
          },
          error: null,
        }),
      },
    }

    const { createSupabaseAuthProvider } = await import('../../server/providers/supabase-auth')
    const provider = createSupabaseAuthProvider()
    const result = await provider.getOAuthRedirectUrl('github', '/auth/callback')

    expect(result.url).toBe('https://supabase.example.com/auth/v1/authorize')
    expect(result.state).toMatch(/^[a-f0-9]{64}$/)
  })

  it('exchanges auth codes and bearer tokens into AuthSession objects', async () => {
    const nowExp = Math.floor(Date.now() / 1000) + 7200
    const tokenPayload = Buffer.from(JSON.stringify({ exp: nowExp })).toString('base64url')
    const accessToken = `header.${tokenPayload}.sig`

    providerState.adminClient = {
      auth: {
        exchangeCodeForSession: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: 'user-1',
              email: 'user@example.com',
              app_metadata: { provider: 'google' },
              user_metadata: {},
            },
            session: {
              access_token: 'access-1',
              refresh_token: 'refresh-1',
              expires_at: 1700001234,
            },
          },
          error: null,
        }),
        getUser: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: 'user-2',
              email: 'token@example.com',
              app_metadata: { provider: 'github' },
              user_metadata: {},
            },
          },
          error: null,
        }),
      },
    }

    const { createSupabaseAuthProvider } = await import('../../server/providers/supabase-auth')
    const provider = createSupabaseAuthProvider()

    await expect(provider.exchangeCode('code-1')).resolves.toMatchObject({
      user: {
        id: 'user-1',
        email: 'user@example.com',
      },
      tokens: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: 1700001234,
      },
    })

    await expect(provider.exchangeTokens(accessToken, 'refresh-2')).resolves.toMatchObject({
      user: {
        id: 'user-2',
        email: 'token@example.com',
      },
      tokens: {
        accessToken,
        refreshToken: 'refresh-2',
        expiresAt: nowExp,
      },
    })
  })

  it('delegates magic links, invites, and user lookup to Supabase Admin APIs', async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null })
    const inviteUserByEmail = vi.fn().mockResolvedValue({
      data: {
        user: { id: 'invited-1' },
      },
      error: null,
    })
    const getUserById = vi.fn().mockResolvedValue({
      data: {
        user: {
          id: 'user-3',
          email: 'lookup@example.com',
          app_metadata: { provider: 'google' },
          user_metadata: {},
        },
      },
      error: null,
    })

    providerState.adminClient = {
      auth: {
        signInWithOtp,
        admin: {
          inviteUserByEmail,
          getUserById,
        },
      },
    }

    const { createSupabaseAuthProvider } = await import('../../server/providers/supabase-auth')
    const provider = createSupabaseAuthProvider()

    await expect(provider.sendMagicLink('magic@example.com', '/auth/callback')).resolves.toBeUndefined()
    await expect(provider.inviteUserByEmail('invite@example.com')).resolves.toEqual({ userId: 'invited-1' })
    await expect(provider.getUserById('user-3')).resolves.toMatchObject({
      id: 'user-3',
      email: 'lookup@example.com',
    })

    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'magic@example.com',
      options: {
        emailRedirectTo: 'http://localhost:3000/auth/callback',
      },
    })
  })
})
