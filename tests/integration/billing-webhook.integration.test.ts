import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string, data?: unknown }) {
  return Object.assign(new Error(input.message), input)
}

/**
 * The per-provider webhook route accepts a `WebhookResult` from the plugin's
 * `handleWebhook`. These tests stub the plugin registry and the database so
 * we can assert the DB writes triggered by each canonical event type.
 */
describe('billing webhook integration', () => {
  const upsertPaymentAccount = vi.fn().mockResolvedValue({})
  const archiveActivePaymentAccount = vi.fn().mockResolvedValue(undefined)
  const updateWorkspace = vi.fn().mockResolvedValue({})
  const getActivePaymentAccount = vi.fn().mockResolvedValue(null)

  let handleWebhookMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    handleWebhookMock = vi.fn()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('readRawBody', vi.fn().mockResolvedValue('{}'))
    vi.stubGlobal('getRequestHeaders', vi.fn().mockReturnValue({}))
    vi.stubGlobal('getRouterParam', vi.fn().mockReturnValue('stripe'))
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({ stripe: { secretKey: 'sk_mock' } }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      upsertPaymentAccount,
      archiveActivePaymentAccount,
      updateWorkspace,
      getActivePaymentAccount,
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    upsertPaymentAccount.mockReset().mockResolvedValue({})
    archiveActivePaymentAccount.mockReset().mockResolvedValue(undefined)
    updateWorkspace.mockReset().mockResolvedValue({})
    getActivePaymentAccount.mockReset().mockResolvedValue(null)
  })

  async function mockPluginAndLoadHandler(options: { configured?: boolean } = {}) {
    const paymentModule = await import('../../server/providers/payment')
    // Flip the bootstrap flag first so the route's lazy bootstrap call is a
    // no-op, then swap the registered Stripe plugin for our mock.
    paymentModule.bootstrapPaymentPlugins()
    const { __resetRegistryForTests } = await import('../../server/providers/payment/registry')
    __resetRegistryForTests()
    paymentModule.registerPlugin({
      key: 'stripe',
      label: 'Stripe',
      isConfigured: () => options.configured ?? true,
      create: () => ({
        createCheckoutSession: vi.fn(),
        createPortalSession: vi.fn(),
        handleWebhook: handleWebhookMock,
        cancelSubscription: vi.fn(),
        ingestUsageEvent: vi.fn(),
      }),
    })
    return (await import('../../server/api/billing/webhook/[provider].post.ts')).default
  }

  it('activates subscription on subscription.created', async () => {
    handleWebhookMock.mockResolvedValue({
      event: 'subscription.created',
      workspaceId: 'ws-1',
      plan: 'pro',
      customerId: 'cus_123',
      subscriptionId: 'sub_123',
      subscriptionStatus: 'trialing',
      currentPeriodEnd: '2026-04-16T00:00:00.000Z',
      trialEndsAt: '2026-04-16T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    })

    const handler = await mockPluginAndLoadHandler()
    const result = await handler({ context: {} } as never)

    expect(result).toEqual({ received: true })
    expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      provider: 'stripe',
      customerId: 'cus_123',
      subscriptionId: 'sub_123',
      subscriptionStatus: 'trialing',
      trialEndsAt: '2026-04-16T00:00:00.000Z',
      plan: 'pro',
      isActive: true,
    }))
    expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', { plan: 'pro' })
  })

  it('updates plan on subscription.updated (portal plan change)', async () => {
    handleWebhookMock.mockResolvedValue({
      event: 'subscription.updated',
      workspaceId: 'ws-1',
      plan: 'starter',
      customerId: 'cus_123',
      subscriptionId: 'sub_123',
      subscriptionStatus: 'active',
      currentPeriodEnd: '2026-05-02T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)

    expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      subscriptionStatus: 'active',
      trialEndsAt: null,
      gracePeriodEndsAt: null,
      plan: 'starter',
    }))
    expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', expect.objectContaining({
      plan: 'starter',
      trial_reminder_stage: 0,
    }))
  })

  it('downgrades to free on subscription.canceled', async () => {
    handleWebhookMock.mockResolvedValue({
      event: 'subscription.canceled',
      workspaceId: 'ws-1',
    })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)

    expect(archiveActivePaymentAccount).toHaveBeenCalledWith('ws-1')
    expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', expect.objectContaining({
      plan: 'free',
      trial_reminder_stage: 0,
    }))
  })

  it('sets grace period on first invoice.payment_failed', async () => {
    getActivePaymentAccount.mockResolvedValue({
      provider: 'stripe',
      customer_id: 'cus_123',
      subscription_id: 'sub_123',
      subscription_status: 'active',
      current_period_end: '2026-05-01T00:00:00.000Z',
      trial_ends_at: null,
      grace_period_ends_at: null,
      cancel_at_period_end: false,
      plan: 'pro',
    })
    handleWebhookMock.mockResolvedValue({
      event: 'invoice.payment_failed',
      workspaceId: 'ws-1',
    })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)

    expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      subscriptionStatus: 'past_due',
      gracePeriodEndsAt: expect.any(String),
    }))
  })

  it('does NOT collapse trialing to active on invoice.paid ($0 trial invoice)', async () => {
    getActivePaymentAccount.mockResolvedValue({
      provider: 'stripe',
      customer_id: 'cus_123',
      subscription_id: 'sub_123',
      subscription_status: 'trialing',
    })
    handleWebhookMock.mockResolvedValue({
      event: 'invoice.paid',
      workspaceId: 'ws-1',
    })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)

    // Should not push any update when subscription is still trialing
    expect(upsertPaymentAccount).not.toHaveBeenCalled()
  })

  it('restores active on invoice.paid when past_due (payment recovery)', async () => {
    getActivePaymentAccount.mockResolvedValue({
      provider: 'stripe',
      customer_id: 'cus_123',
      subscription_id: 'sub_123',
      subscription_status: 'past_due',
      current_period_end: '2026-05-01T00:00:00.000Z',
      trial_ends_at: null,
      grace_period_ends_at: '2026-04-28T00:00:00.000Z',
      cancel_at_period_end: false,
      plan: 'pro',
    })
    handleWebhookMock.mockResolvedValue({
      event: 'invoice.paid',
      workspaceId: 'ws-1',
    })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)

    expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      subscriptionStatus: 'active',
      gracePeriodEndsAt: null,
    }))
  })

  it('returns 503 when provider is not configured', async () => {
    const handler = await mockPluginAndLoadHandler({ configured: false })
    await expect(handler({ context: {} } as never)).rejects.toMatchObject({
      statusCode: 503,
    })
  })

  it('returns 404 for unknown provider', async () => {
    vi.stubGlobal('getRouterParam', vi.fn().mockReturnValue('unknown'))
    const handler = await mockPluginAndLoadHandler()
    await expect(handler({ context: {} } as never)).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})
