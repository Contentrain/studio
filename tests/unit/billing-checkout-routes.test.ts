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
      }),
      getActivePaymentAccount: vi.fn().mockResolvedValue({
        provider: 'polar',
        customer_id: 'cus_123',
        subscription_id: 'sub_123',
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
      url: 'https://checkout.polar.sh/c/test',
      sessionId: 'cs_test_123',
    })
    const { checkRateLimit } = await import('../../server/utils/rate-limit')

    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getWorkspaceForUser: vi.fn().mockResolvedValue({
        id: 'workspace-1',
        slug: 'team',
        name: 'Team',
      }),
      getActivePaymentAccount: vi.fn().mockResolvedValue(null),
    }))
    vi.stubGlobal('checkRateLimit', checkRateLimit)
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({ createCheckoutSession }))

    const handler = (await import('../../server/api/billing/checkout.post')).default

    await expect(handler({} as never)).resolves.toEqual({
      url: 'https://checkout.polar.sh/c/test',
    })
    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 429,
      message: 'auth.rate_limited',
    })
    expect(createCheckoutSession).toHaveBeenCalledTimes(1)
  })

  it('returns a clean 502 when the payment provider call fails (e.g. expired token)', async () => {
    const createCheckoutSession = vi.fn().mockRejectedValue(
      Object.assign(new Error('API error occurred: Status 401'), { statusCode: 401 }),
    )

    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getWorkspaceForUser: vi.fn().mockResolvedValue({
        id: 'workspace-1',
        slug: 'team',
        name: 'Team',
        trial_consumed_at: null,
      }),
      getActivePaymentAccount: vi.fn().mockResolvedValue(null),
    }))
    vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({ allowed: true, remaining: 1, retryAfterMs: 0 }))
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({ createCheckoutSession }))
    // Swallow the expected ops log so the failing-provider path stays quiet.
    vi.stubGlobal('console', { ...console, error: vi.fn() })

    const handler = (await import('../../server/api/billing/checkout.post')).default

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 502,
      message: 'billing.provider_unavailable',
    })
    expect(createCheckoutSession).toHaveBeenCalledTimes(1)
  })
  describe('returnTo', () => {
    async function checkoutWith(returnTo?: string) {
      const createCheckoutSession = vi.fn().mockResolvedValue({ url: 'https://checkout.polar.sh/c/x', sessionId: 's' })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ workspaceId: 'workspace-1', plan: 'starter', ...(returnTo === undefined ? {} : { returnTo }) }))
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'workspace-1', slug: 'team', name: 'Team' }),
        getActivePaymentAccount: vi.fn().mockResolvedValue(null),
      }))
      vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({ allowed: true, remaining: 1, retryAfterMs: 0 }))
      vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({ createCheckoutSession }))
      const handler = (await import('../../server/api/billing/checkout.post')).default
      await handler({} as never)
      return createCheckoutSession.mock.calls[0]![0].successUrl as string
    }

    it('sends the customer back to the Migrate claim they came from', async () => {
      expect(await checkoutWith('/migrate/claim?grant=mg_1')).toBe('https://studio.example.com/migrate/claim?grant=mg_1')
    })

    it('keeps today\'s success page when there is no returnTo', async () => {
      expect(await checkoutWith()).toBe('https://studio.example.com/w/team/settings?billing=success')
    })

    it.each([
      'https://evil.example/claim',
      '//evil.example/migrate/claim',
      '/\\evil.example',
      '/migrate/claim/../../admin',
      '/w/team/settings',
      '/migrate/claimx',
      'migrate/claim',
      '/migrate/claim\r\nX: 1',
    ])('drops an open-redirect attempt %j', async (bad) => {
      expect(await checkoutWith(bad)).toBe('https://studio.example.com/w/team/settings?billing=success')
    })
  })
})
