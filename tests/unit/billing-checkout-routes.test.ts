import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

describe('billing checkout route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1', email: 'owner@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      plan: 'starter',
    }))
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      public: { siteUrl: 'https://studio.example.com' },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 409 when the workspace already has an active subscription', async () => {
    const createCheckoutSession = vi.fn()

    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getWorkspaceForUser: vi.fn().mockResolvedValue({
        id: 'workspace-1',
        slug: 'team',
        name: 'Team',
        stripe_subscription_id: 'sub_123',
        subscription_status: 'active',
      }),
    }))
    vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    }))
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({ createCheckoutSession }))

    const handler = (await import('../../server/api/billing/checkout.post')).default

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 409,
      message: 'billing.subscription_exists',
    })
    expect(createCheckoutSession).not.toHaveBeenCalled()
  })

  it('rate limits duplicate checkout attempts for the same workspace', async () => {
    const createCheckoutSession = vi.fn().mockResolvedValue({
      url: 'https://checkout.stripe.com/c/pay/test',
      sessionId: 'cs_test_123',
    })
    const { checkRateLimit } = await import('../../server/utils/rate-limit')

    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getWorkspaceForUser: vi.fn().mockResolvedValue({
        id: 'workspace-1',
        slug: 'team',
        name: 'Team',
        stripe_subscription_id: null,
        subscription_status: null,
      }),
    }))
    vi.stubGlobal('checkRateLimit', checkRateLimit)
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({ createCheckoutSession }))

    const handler = (await import('../../server/api/billing/checkout.post')).default

    await expect(handler({} as never)).resolves.toEqual({
      url: 'https://checkout.stripe.com/c/pay/test',
    })
    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 429,
      message: 'auth.rate_limited',
    })
    expect(createCheckoutSession).toHaveBeenCalledTimes(1)
  })
})
