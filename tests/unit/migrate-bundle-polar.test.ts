import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkoutsCreate = vi.fn()
const subscriptionsGet = vi.fn()
const subscriptionsUpdate = vi.fn()
vi.mock('@polar-sh/sdk', () => ({
  Polar: class {
    checkouts = { create: checkoutsCreate }
    subscriptions = { get: subscriptionsGet, update: subscriptionsUpdate }
  },
}))
const validateEvent = vi.fn()
vi.mock('@polar-sh/sdk/webhooks', () => ({
  validateEvent: (...args: unknown[]) => validateEvent(...args),
  WebhookVerificationError: class extends Error {},
}))

const polarConfig = {
  accessToken: 'tok',
  webhookSecret: 'sec',
  starterProductId: 'prod_starter_m',
  proProductId: 'prod_pro_m',
  starterBundleProductId: 'prod_starter_bundle',
  proBundleProductId: 'prod_pro_bundle',
  starterYearlyProductId: 'prod_starter_y',
  proYearlyProductId: 'prod_pro_y',
}

async function polar(config: Record<string, unknown> = polarConfig) {
  const { polarPlugin } = await import('../../server/providers/payment/plugins/polar')
  return polarPlugin.create({ polar: config } as never)
}

const input = {
  workspaceId: 'ws-1',
  plan: 'pro' as const,
  customerEmail: 'owner@example.com',
  amountCents: 64100,
  successUrl: 'https://migrate.contentrain.io/orders/ord_1?studio=done',
  metadata: { order_id: 'ord_1', tenant_id: 'ten_1', migrate_grant_id: 'grant-1', workspace_id: 'ws-evil', plan: 'starter' },
}

describe('polar bundle checkout', () => {
  beforeEach(() => {
    checkoutsCreate.mockReset().mockResolvedValue({ url: 'https://sandbox.polar.sh/checkout/c_1', id: 'co_1', expiresAt: new Date('2026-10-04T10:00:00Z') })
  })

  it('sells the bundle product at the quoted total, with no trial and no discount code', async () => {
    const result = await (await polar()).createBundleCheckout(input)

    expect(checkoutsCreate).toHaveBeenCalledWith(expect.objectContaining({
      products: ['prod_pro_bundle'],
      prices: { prod_pro_bundle: [{ amountType: 'fixed', priceCurrency: 'usd', priceAmount: 64100 }] },
      customerEmail: 'owner@example.com',
      externalCustomerId: 'ws-1',
      successUrl: input.successUrl,
      allowTrial: false,
      allowDiscountCodes: false,
    }))
    expect(result).toEqual({
      url: 'https://sandbox.polar.sh/checkout/c_1',
      sessionId: 'co_1',
      expiresAt: '2026-10-04T10:00:00.000Z',
      targetProductId: 'prod_pro_y',
    })
  })

  it('carries order, tenant and grant to the subscription, and metadata cannot overwrite the workspace or plan', async () => {
    await (await polar()).createBundleCheckout(input)
    expect(checkoutsCreate.mock.calls[0]![0]).toMatchObject({
      metadata: { order_id: 'ord_1', tenant_id: 'ten_1', migrate_grant_id: 'grant-1', workspace_id: 'ws-1', plan: 'pro' },
    })
  })

  it('uses the starter products for a starter bundle', async () => {
    const result = await (await polar()).createBundleCheckout({ ...input, plan: 'starter', amountCents: 24900 })
    expect(checkoutsCreate.mock.calls[0]![0]).toMatchObject({ products: ['prod_starter_bundle'] })
    expect(result.targetProductId).toBe('prod_starter_y')
  })

  it('refuses when the bundle or yearly product is not configured (the bundle is off)', async () => {
    const { starterBundleProductId: _s, proBundleProductId: _p, ...partial } = polarConfig
    await expect((await polar(partial)).createBundleCheckout(input)).rejects.toThrow(/No Polar bundle\/yearly product/)
    expect(checkoutsCreate).not.toHaveBeenCalled()
  })
})

describe('polar: moving a bundle subscription to its list product', () => {
  beforeEach(() => {
    subscriptionsGet.mockReset()
    subscriptionsUpdate.mockReset().mockResolvedValue({})
  })

  it('schedules the yearly product for the next period, charging nothing now', async () => {
    subscriptionsGet.mockResolvedValue({ productId: 'prod_pro_bundle', pendingUpdate: null })
    const result = await (await polar()).moveBundleSubscriptionToList('sub_1', 'pro')

    expect(subscriptionsUpdate).toHaveBeenCalledWith({
      id: 'sub_1',
      subscriptionUpdate: { productId: 'prod_pro_y', prorationBehavior: 'next_period' },
    })
    expect(result).toEqual({ productId: 'prod_pro_y', alreadyOnList: false })
  })

  it('does nothing when the subscription is on the list product, or the move is already scheduled', async () => {
    const provider = await polar()
    subscriptionsGet.mockResolvedValueOnce({ productId: 'prod_pro_y', pendingUpdate: null })
    expect(await provider.moveBundleSubscriptionToList('sub_1', 'pro')).toEqual({ productId: 'prod_pro_y', alreadyOnList: true })
    subscriptionsGet.mockResolvedValueOnce({ productId: 'prod_pro_bundle', pendingUpdate: { productId: 'prod_pro_y' } })
    expect(await provider.moveBundleSubscriptionToList('sub_1', 'pro')).toEqual({ productId: 'prod_pro_y', alreadyOnList: true })
    expect(subscriptionsUpdate).not.toHaveBeenCalled()
  })

  it('lets the failure out, so the caller keeps the subscription pending', async () => {
    subscriptionsGet.mockResolvedValue({ productId: 'prod_pro_bundle', pendingUpdate: null })
    subscriptionsUpdate.mockRejectedValue(new Error('polar down'))
    await expect((await polar()).moveBundleSubscriptionToList('sub_1', 'pro')).rejects.toThrow('polar down')
  })
})

describe('polar webhook: bundle and yearly products read as their plan', () => {
  const subscription = (productId: string, metadata: Record<string, unknown> = {}) => ({
    type: 'subscription.created',
    data: { id: 'sub_1', status: 'active', customerId: 'cus_1', productId, currentPeriodStart: null, currentPeriodEnd: null, trialEnd: null, cancelAtPeriodEnd: false, metadata },
  })

  it.each([
    ['prod_pro_bundle', 'pro'],
    ['prod_pro_y', 'pro'],
    ['prod_starter_bundle', 'starter'],
    ['prod_starter_y', 'starter'],
    ['prod_pro_m', 'pro'],
  ])('%s is %s, and the result names the product', async (productId, plan) => {
    validateEvent.mockReturnValue(subscription(productId, { workspace_id: 'ws-1', migrate_grant_id: 'grant-1' }))
    const result = await (await polar()).handleWebhook('{}', {})
    expect(result).toMatchObject({ event: 'subscription.created', plan, productId, migrateGrantId: 'grant-1', workspaceId: 'ws-1' })
  })
})
