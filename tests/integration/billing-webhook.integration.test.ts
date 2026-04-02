import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string, data?: unknown }) {
  return Object.assign(new Error(input.message), input)
}

describe('billing webhook integration', () => {
  const updateWorkspace = vi.fn().mockResolvedValue({})
  const getWorkspaceById = vi.fn().mockResolvedValue(null)

  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('readRawBody', vi.fn().mockResolvedValue('{}'))
    vi.stubGlobal('getRequestHeader', vi.fn().mockReturnValue('sig_test'))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      updateWorkspace,
      getWorkspaceById,
    }))
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({
      handleWebhook: vi.fn(),
    }))
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    updateWorkspace.mockReset()
    getWorkspaceById.mockReset()
  })

  it('activates subscription on checkout.session.completed', async () => {
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({
      handleWebhook: vi.fn().mockResolvedValue({
        event: 'checkout.session.completed',
        workspaceId: 'ws-1',
        plan: 'pro',
        customerId: 'cus_123',
        subscriptionId: 'sub_123',
        subscriptionStatus: 'trialing',
        currentPeriodEnd: '2026-04-16T00:00:00.000Z',
        cancelAtPeriodEnd: false,
      }),
    }))

    const handler = (await import('../../server/api/billing/webhook.post.ts')).default
    const result = await handler({ context: {} } as never)

    expect(result).toEqual({ received: true })
    expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', expect.objectContaining({
      plan: 'pro',
      subscription_status: 'trialing',
      stripe_customer_id: 'cus_123',
      stripe_subscription_id: 'sub_123',
      trial_ends_at: '2026-04-16T00:00:00.000Z',
    }))
  })

  it('updates plan on subscription.updated (Portal plan change)', async () => {
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({
      handleWebhook: vi.fn().mockResolvedValue({
        event: 'customer.subscription.updated',
        workspaceId: 'ws-1',
        plan: 'starter',
        subscriptionStatus: 'active',
        currentPeriodEnd: '2026-05-02T00:00:00.000Z',
        cancelAtPeriodEnd: false,
      }),
    }))

    const handler = (await import('../../server/api/billing/webhook.post.ts')).default
    await handler({ context: {} } as never)

    expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', expect.objectContaining({
      plan: 'starter',
      subscription_status: 'active',
      trial_ends_at: null,
      grace_period_ends_at: null,
    }))
  })

  it('downgrades to free on subscription.deleted', async () => {
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({
      handleWebhook: vi.fn().mockResolvedValue({
        event: 'customer.subscription.deleted',
        workspaceId: 'ws-1',
      }),
    }))

    const handler = (await import('../../server/api/billing/webhook.post.ts')).default
    await handler({ context: {} } as never)

    expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', expect.objectContaining({
      plan: 'free',
      subscription_status: null,
      stripe_subscription_id: null,
    }))
  })

  it('sets grace period on first invoice.payment_failed', async () => {
    getWorkspaceById.mockResolvedValue({ grace_period_ends_at: null })
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({
      handleWebhook: vi.fn().mockResolvedValue({
        event: 'invoice.payment_failed',
        workspaceId: 'ws-1',
      }),
    }))

    const handler = (await import('../../server/api/billing/webhook.post.ts')).default
    await handler({ context: {} } as never)

    expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', expect.objectContaining({
      subscription_status: 'past_due',
      grace_period_ends_at: expect.any(String),
    }))
  })

  it('does NOT collapse trialing to active on invoice.paid ($0 trial invoice)', async () => {
    getWorkspaceById.mockResolvedValue({ subscription_status: 'trialing' })
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({
      handleWebhook: vi.fn().mockResolvedValue({
        event: 'invoice.paid',
        workspaceId: 'ws-1',
      }),
    }))

    const handler = (await import('../../server/api/billing/webhook.post.ts')).default
    await handler({ context: {} } as never)

    // Should NOT set subscription_status to 'active'
    expect(updateWorkspace).not.toHaveBeenCalled()
  })

  it('restores active on invoice.paid when past_due (payment recovery)', async () => {
    getWorkspaceById.mockResolvedValue({ subscription_status: 'past_due' })
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({
      handleWebhook: vi.fn().mockResolvedValue({
        event: 'invoice.paid',
        workspaceId: 'ws-1',
      }),
    }))

    const handler = (await import('../../server/api/billing/webhook.post.ts')).default
    await handler({ context: {} } as never)

    expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', {
      subscription_status: 'active',
      grace_period_ends_at: null,
    })
  })

  it('returns 503 when payment provider is not configured', async () => {
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue(null))

    const handler = (await import('../../server/api/billing/webhook.post.ts')).default
    await expect(handler({ context: {} } as never)).rejects.toMatchObject({
      statusCode: 503,
    })
  })
})
