import { beforeEach, describe, expect, it, vi } from 'vitest'

const subscriptionsList = vi.fn()
const subscriptionsCreate = vi.fn()
const subscriptionsGet = vi.fn()
vi.mock('@polar-sh/sdk', () => ({
  Polar: class {
    subscriptions = { list: subscriptionsList, create: subscriptionsCreate, get: subscriptionsGet }
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
  starterCompanionProductId: 'prod_starter_c',
  proCompanionProductId: 'prod_pro_c',
  companionUsage: true,
}

async function polar(config: Record<string, unknown> = polarConfig) {
  const { polarPlugin } = await import('../../server/providers/payment/plugins/polar')
  return polarPlugin.create({ polar: config } as never)
}

async function* pageGen(items: Array<{ id: string }>) {
  yield { result: { items } }
}
const emptyPage = () => pageGen([])
const pageOf = (...ids: string[]) => pageGen(ids.map(id => ({ id })))

const input = { workspaceId: 'ws-1', plan: 'pro' as const, customerId: 'cus_1', parentSubscriptionId: 'sub_1', parentProductId: 'prod_pro_y' }

describe('polar companion subscription', () => {
  beforeEach(() => {
    subscriptionsList.mockReset().mockResolvedValue(emptyPage())
    subscriptionsCreate.mockReset().mockResolvedValue({ id: 'sub_c1' })
    subscriptionsGet.mockReset().mockResolvedValue({ productId: 'prod_pro_y' })
  })

  it('opens the plan\'s companion product for the customer, tagged and tied to the plan subscription', async () => {
    expect(await (await polar()).ensureCompanionSubscription!(input)).toMatchObject({ subscriptionId: 'sub_c1', created: true, parentProductId: expect.any(String) })
    expect(subscriptionsCreate).toHaveBeenCalledWith({
      productId: 'prod_pro_c',
      customerId: 'cus_1',
      metadata: { contentrain_companion: 'true', workspace_id: 'ws-1', plan: 'pro', parent_subscription_id: 'sub_1' },
    })
  })

  it('uses the starter companion for a starter plan', async () => {
    await (await polar()).ensureCompanionSubscription!({ ...input, plan: 'starter', parentProductId: 'prod_starter_bundle' })
    expect(subscriptionsCreate.mock.calls[0]![0]).toMatchObject({ productId: 'prod_starter_c' })
  })

  it('is off unless the flag is on: no call to Polar at all', async () => {
    const off = await polar({ ...polarConfig, companionUsage: false })
    expect(await off.ensureCompanionSubscription!(input)).toBeNull()
    expect(subscriptionsList).not.toHaveBeenCalled()
    expect(subscriptionsCreate).not.toHaveBeenCalled()
  })

  it('accepts the flag as the string an env var gives', async () => {
    expect(await (await polar({ ...polarConfig, companionUsage: 'true' })).ensureCompanionSubscription!(input)).toMatchObject({ created: true })
  })

  it('is off for a plan with no companion product', async () => {
    expect(await (await polar({ ...polarConfig, proCompanionProductId: '' })).ensureCompanionSubscription!(input)).toBeNull()
    expect(subscriptionsCreate).not.toHaveBeenCalled()
  })

  it('never gives a monthly plan a companion: it bills its overage monthly already', async () => {
    expect(await (await polar()).ensureCompanionSubscription!({ ...input, parentProductId: 'prod_pro_m' })).toBeNull()
    expect(subscriptionsList).not.toHaveBeenCalled()
  })

  it('reads the parent\'s product from the subscription when the caller does not know it', async () => {
    const { parentProductId: _drop, ...withoutProduct } = input
    expect(await (await polar()).ensureCompanionSubscription!(withoutProduct)).toMatchObject({ created: true })
    expect(subscriptionsGet).toHaveBeenCalledWith({ id: 'sub_1' })
    subscriptionsGet.mockResolvedValue({ productId: 'prod_pro_m' })
    subscriptionsCreate.mockClear()
    expect(await (await polar()).ensureCompanionSubscription!(withoutProduct)).toBeNull()
    expect(subscriptionsCreate).not.toHaveBeenCalled()
  })

  it('returns the active companion the customer already has instead of opening a second one', async () => {
    subscriptionsList.mockResolvedValue(pageOf('sub_existing'))
    expect(await (await polar()).ensureCompanionSubscription!(input)).toMatchObject({ subscriptionId: 'sub_existing', created: false })
    expect(subscriptionsList).toHaveBeenCalledWith({ customerId: 'cus_1', productId: 'prod_pro_c', active: true })
    expect(subscriptionsCreate).not.toHaveBeenCalled()
  })
})

describe('polar webhook: companion events are marked, plan events are not', () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    id: 'sub_c1', status: 'active', customerId: 'cus_1', productId: 'prod_pro_c', checkoutId: null,
    currentPeriodStart: '2026-10-05T00:00:00Z', currentPeriodEnd: '2026-11-05T00:00:00Z', trialEnd: null, cancelAtPeriodEnd: false,
    metadata: { contentrain_companion: 'true', workspace_id: 'ws-1', plan: 'pro' },
    prices: [{ amountType: 'metered_unit', meter: { name: 'ai_credits_1c' } }, { amountType: 'metered_unit', meter: { name: 'api_credits_1c' } }],
    ...over,
  })
  const handle = async (type: string, data: unknown) => {
    validateEvent.mockReturnValue({ type, data })
    return (await polar()).handleWebhook('{}', {})
  }

  it('marks a created companion and carries the meters it prices', async () => {
    expect(await handle('subscription.created', sub())).toMatchObject({ event: 'subscription.created', companion: true, subscriptionId: 'sub_c1', billableMeters: ['ai_credits_1c', 'api_credits_1c'] })
  })

  it('marks it by its product when the metadata is missing', async () => {
    expect(await handle('subscription.updated', sub({ metadata: {} }))).toMatchObject({ companion: true })
  })

  it('marks an ended companion', async () => {
    expect(await handle('subscription.revoked', sub({ status: 'canceled', endedAt: '2026-11-01T00:00:00Z' }))).toMatchObject({ event: 'subscription.canceled', companion: true, subscriptionId: 'sub_c1' })
  })

  it('marks a companion\'s order, so its usage invoice never reads as the plan\'s payment', async () => {
    const result = await handle('order.paid', { id: 'ord_1', customerId: 'cus_1', subscriptionId: 'sub_c1', productId: 'prod_pro_c', totalAmount: 1200, billingReason: 'subscription_cycle', metadata: {}, subscription: { metadata: { contentrain_companion: 'true', workspace_id: 'ws-1' } } })
    expect(result).toMatchObject({ event: 'invoice.paid', companion: true })
  })

  it('does not mark the plan subscription or its order', async () => {
    const plan = await handle('subscription.created', sub({ id: 'sub_1', productId: 'prod_pro_y', metadata: { workspace_id: 'ws-1', plan: 'pro' }, prices: [] }))
    expect(plan.companion).toBeUndefined()
    const order = await handle('order.paid', { id: 'ord_2', customerId: 'cus_1', subscriptionId: 'sub_1', productId: 'prod_pro_y', totalAmount: 7200, metadata: { workspace_id: 'ws-1' } })
    expect(order.companion).toBeUndefined()
  })
})
