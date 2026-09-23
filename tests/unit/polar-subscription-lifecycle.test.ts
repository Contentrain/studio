import { beforeEach, describe, expect, it, vi } from 'vitest'

// The webhook signature is not under test: hand the plugin the parsed event.
const validateEvent = vi.fn()
vi.mock('@polar-sh/sdk/webhooks', () => ({
  validateEvent: (...args: unknown[]) => validateEvent(...args),
  WebhookVerificationError: class extends Error {},
}))

/**
 * Payload shapes as Polar sends them (sandbox, 2026-09-23): the fields
 * that change across a subscription's cancel and revoke events.
 */
function subscription(overrides: Record<string, unknown>) {
  return {
    id: 'sub_1',
    status: 'active',
    customerId: 'cus_1',
    productId: 'prod_pro',
    currentPeriodStart: new Date('2026-09-23T11:50:43.823Z'),
    currentPeriodEnd: new Date('2026-10-23T11:50:43.823Z'),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    endsAt: null,
    endedAt: null,
    metadata: { workspace_id: 'ws-1' },
    ...overrides,
  }
}

async function handle(type: string, data: Record<string, unknown>) {
  validateEvent.mockReturnValue({ type, data })
  const { polarPlugin } = await import('../../server/providers/payment/plugins/polar')
  const provider = polarPlugin.create({ polar: { accessToken: 'tok', webhookSecret: 'sec', proProductId: 'prod_pro' } } as never)
  return provider.handleWebhook('{}', {})
}

describe('polar plugin — cancel and revoke keep what was paid for', () => {
  beforeEach(() => validateEvent.mockReset())

  it('keeps the subscription when a cancellation is scheduled for the period end', async () => {
    // Polar sends `subscription.canceled` the moment the customer cancels,
    // while the subscription is still active and paid for.
    const result = await handle('subscription.canceled', subscription({
      cancelAtPeriodEnd: true,
      canceledAt: new Date('2026-09-23T11:51:37.504Z'),
      endsAt: new Date('2026-10-23T11:50:43.823Z'),
    }))

    expect(result).toMatchObject({
      event: 'subscription.updated',
      workspaceId: 'ws-1',
      plan: 'pro',
      subscriptionStatus: 'active',
      cancelAtPeriodEnd: true,
      accessEndsAt: '2026-10-23T11:50:43.823Z',
      currentPeriodEnd: '2026-10-23T11:50:43.823Z',
    })
  })

  it('keeps a trial that is canceled until the trial ends', async () => {
    const result = await handle('subscription.canceled', subscription({
      status: 'trialing',
      trialEnd: new Date('2026-09-29T11:50:45.420Z'),
      currentPeriodEnd: new Date('2026-09-29T11:50:45.420Z'),
      cancelAtPeriodEnd: true,
      endsAt: new Date('2026-09-29T11:50:45.420Z'),
    }))

    expect(result).toMatchObject({
      event: 'subscription.updated',
      subscriptionStatus: 'trialing',
      trialEndsAt: '2026-09-29T11:50:45.420Z',
      cancelAtPeriodEnd: true,
    })
  })

  it('reports an undone cancellation as a plain update', async () => {
    const result = await handle('subscription.uncanceled', subscription({}))
    expect(result).toMatchObject({ event: 'subscription.updated', subscriptionStatus: 'active', cancelAtPeriodEnd: false })
    expect(result.accessEndsAt).toBeUndefined()
  })

  it.each(['subscription.updated', 'subscription.canceled', 'subscription.revoked'])(
    'ends access when %s says the subscription has ended',
    async (type) => {
      // An immediate revoke (or a period-end cancel taking effect) arrives as
      // updated → canceled → revoked, every one with status `canceled`.
      const ended = new Date('2026-09-23T11:51:56.892Z')
      const result = await handle(type, subscription({ status: 'canceled', canceledAt: ended, endsAt: ended, endedAt: ended }))

      expect(result).toMatchObject({
        event: 'subscription.canceled',
        workspaceId: 'ws-1',
        subscriptionId: 'sub_1',
        subscriptionStatus: 'canceled',
      })
    },
  )

  it('reports a failed renewal as past_due', async () => {
    const result = await handle('subscription.past_due', subscription({ status: 'past_due' }))
    expect(result).toMatchObject({ event: 'subscription.updated', subscriptionStatus: 'past_due' })
  })
})
