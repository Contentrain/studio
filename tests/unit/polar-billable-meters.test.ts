import { describe, expect, it, vi } from 'vitest'

// The webhook signature is not under test: hand the plugin the parsed event.
const validateEvent = vi.fn()
vi.mock('@polar-sh/sdk/webhooks', () => ({
  validateEvent: (...args: unknown[]) => validateEvent(...args),
  WebhookVerificationError: class extends Error {},
}))

function subscription(prices: unknown) {
  return {
    id: 'sub_1',
    status: 'active',
    customerId: 'cus_1',
    productId: 'prod_pro',
    currentPeriodStart: new Date('2026-09-29T07:36:51.653Z'),
    currentPeriodEnd: new Date('2026-10-29T07:36:51.653Z'),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    metadata: { workspace_id: 'ws-1' },
    prices,
  }
}

async function handle(prices: unknown) {
  validateEvent.mockReturnValue({ type: 'subscription.updated', data: subscription(prices) })
  const { polarPlugin } = await import('../../server/providers/payment/plugins/polar')
  const provider = polarPlugin.create({ polar: { accessToken: 'tok', webhookSecret: 'sec', proProductId: 'prod_pro' } } as never)
  return provider.handleWebhook('{}', {})
}

describe('polar plugin — the meters a subscription prices', () => {
  it('reports the metered prices the subscription carries, not the product\'s', async () => {
    // The shape a subscription created before the credit meters still has.
    const result = await handle([
      { amountType: 'fixed', priceAmount: 4900 },
      { amountType: 'metered_unit', meter: { name: 'ai_messages' } },
      { amountType: 'metered_unit', meter: { name: 'mcp_calls' } },
      { amountType: 'metered_unit', meter: { name: 'api_messages' } },
    ])
    expect(result.billableMeters).toEqual(['ai_messages', 'api_messages', 'mcp_calls'])
  })

  it('reports an empty list for a subscription with no metered price', async () => {
    const result = await handle([{ amountType: 'fixed', priceAmount: 900 }])
    expect(result.billableMeters).toEqual([])
  })

  it('reports nothing when the payload carries no prices', async () => {
    const result = await handle(undefined)
    expect(result.billableMeters).toBeUndefined()
  })
})

describe('polar plugin — order.paid', () => {
  it('names the workspace from the customer when a renewal order carries no checkout metadata, and reports the amount', async () => {
    validateEvent.mockReturnValue({
      type: 'order.paid',
      data: { id: 'ord_1', customerId: 'cus_1', subscriptionId: 'sub_1', totalAmount: 4900, metadata: {}, subscription: { metadata: {} }, customer: { externalId: 'ws-1' } },
    })
    const { polarPlugin } = await import('../../server/providers/payment/plugins/polar')
    const provider = polarPlugin.create({ polar: { accessToken: 'tok', webhookSecret: 'sec' } } as never)
    await expect(provider.handleWebhook('{}', {})).resolves.toMatchObject({ event: 'invoice.paid', workspaceId: 'ws-1', amountPaid: 4900 })
  })
})
