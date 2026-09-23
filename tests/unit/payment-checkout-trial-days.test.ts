import { beforeEach, describe, expect, it, vi } from 'vitest'

const polarCheckoutsCreate = vi.fn()
vi.mock('@polar-sh/sdk', () => ({
  Polar: class {
    checkouts = { create: polarCheckoutsCreate }
  },
}))
const validateEvent = vi.fn()
vi.mock('@polar-sh/sdk/webhooks', () => ({
  validateEvent: (...args: unknown[]) => validateEvent(...args),
  WebhookVerificationError: class extends Error {},
}))
const stripeSessionsCreate = vi.fn()
vi.mock('stripe', () => ({
  default: class {
    checkout = { sessions: { create: stripeSessionsCreate } }
  },
}))

const base = {
  workspaceId: 'ws-1',
  workspaceName: 'Acme',
  plan: 'pro' as const,
  customerEmail: 'owner@example.com',
  successUrl: 'https://studio.example.com/ok',
  cancelUrl: 'https://studio.example.com/back',
}

async function polar() {
  const { polarPlugin } = await import('../../server/providers/payment/plugins/polar')
  return polarPlugin.create({ polar: { accessToken: 'tok', webhookSecret: 'sec', proProductId: 'prod_pro', starterProductId: 'prod_starter' } } as never)
}

describe('a grant\'s trial length reaches the provider checkout', () => {
  beforeEach(() => {
    polarCheckoutsCreate.mockReset().mockResolvedValue({ url: 'https://polar/c', id: 'co_1' })
    stripeSessionsCreate.mockReset().mockResolvedValue({ url: 'https://stripe/c', id: 'cs_1' })
  })

  it('polar: sets the checkout\'s own trial and carries the grant id to the subscription', async () => {
    await (await polar()).createCheckoutSession({ ...base, withTrial: true, trialDays: 60, metadata: { migrate_grant_id: 'grant-1' } })

    expect(polarCheckoutsCreate).toHaveBeenCalledWith(expect.objectContaining({
      products: ['prod_pro'],
      trialInterval: 'day',
      trialIntervalCount: 60,
      metadata: { migrate_grant_id: 'grant-1', workspace_id: 'ws-1', plan: 'pro' },
    }))
  })

  it('polar: without a grant, the product\'s trial applies unchanged', async () => {
    await (await polar()).createCheckoutSession({ ...base, withTrial: true })
    const args = polarCheckoutsCreate.mock.calls[0]![0] as Record<string, unknown>
    expect(args.trialInterval).toBeUndefined()
    expect(args.trialIntervalCount).toBeUndefined()
  })

  it('polar: no trial wins over a trial length', async () => {
    await (await polar()).createCheckoutSession({ ...base, withTrial: false, trialDays: 60 })
    const args = polarCheckoutsCreate.mock.calls[0]![0] as Record<string, unknown>
    expect(args.allowTrial).toBe(false)
    expect(args.trialIntervalCount).toBeUndefined()
  })

  it('polar: metadata cannot overwrite the workspace or plan', async () => {
    await (await polar()).createCheckoutSession({ ...base, metadata: { workspace_id: 'ws-evil', plan: 'enterprise' } })
    expect(polarCheckoutsCreate.mock.calls[0]![0]).toMatchObject({ metadata: { workspace_id: 'ws-1', plan: 'pro' } })
  })

  it('polar: reports the grant a subscription was started from', async () => {
    validateEvent.mockReturnValue({
      type: 'subscription.created',
      data: {
        id: 'sub_1',
        status: 'trialing',
        customerId: 'cus_1',
        productId: 'prod_pro',
        currentPeriodStart: new Date('2026-09-23T12:00:00Z'),
        currentPeriodEnd: new Date('2026-11-22T12:00:00Z'),
        trialEnd: new Date('2026-11-22T12:00:00Z'),
        cancelAtPeriodEnd: false,
        metadata: { workspace_id: 'ws-1', plan: 'pro', migrate_grant_id: 'grant-1' },
      },
    })
    const result = await (await polar()).handleWebhook('{}', {})
    expect(result).toMatchObject({ event: 'subscription.created', migrateGrantId: 'grant-1', trialEndsAt: '2026-11-22T12:00:00.000Z' })
  })

  it('stripe: the trial length follows the grant, the default otherwise', async () => {
    const { stripePlugin } = await import('../../server/providers/payment/plugins/stripe')
    const stripe = stripePlugin.create({ stripe: { secretKey: 'sk', proPriceId: 'price_pro' } } as never)

    await stripe.createCheckoutSession({ ...base, trialDays: 60, metadata: { migrate_grant_id: 'grant-1' } })
    expect(stripeSessionsCreate.mock.calls[0]![0]).toMatchObject({
      subscription_data: { trial_period_days: 60, metadata: { migrate_grant_id: 'grant-1', workspace_id: 'ws-1' } },
    })

    await stripe.createCheckoutSession(base)
    expect(stripeSessionsCreate.mock.calls[1]![0]).toMatchObject({ subscription_data: { trial_period_days: 14 } })
  })
})
