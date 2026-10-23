import { beforeEach, describe, expect, it, vi } from 'vitest'

// The webhook signature is not under test: hand the plugin the parsed event.
const validateEvent = vi.fn()
vi.mock('@polar-sh/sdk/webhooks', () => ({
  validateEvent: (...args: unknown[]) => validateEvent(...args),
  WebhookVerificationError: class extends Error {},
}))

const WORKSPACE = '00000000-0000-4000-8000-000000000001'
const products = {
  starterProductId: 'prod_starter_m',
  proProductId: 'prod_pro_m',
  starterBundleProductId: 'prod_starter_bundle',
  proBundleProductId: 'prod_pro_bundle',
  starterYearlyProductId: 'prod_starter_y',
  proYearlyProductId: 'prod_pro_y',
}

async function handle(type: string, data: Record<string, unknown>) {
  validateEvent.mockReturnValue({ type, data })
  const { polarPlugin } = await import('../../server/providers/payment/plugins/polar')
  return polarPlugin.create({ polar: { accessToken: 'tok', webhookSecret: 'sec', ...products } } as never).handleWebhook('{}', {})
}

/** Migrate's own order on the shared Polar org, as staging received it (2026-10-23): its tenant id, not a workspace. */
const migrateOrder = {
  id: 'ord_m1',
  customerId: 'cus_m1',
  subscriptionId: null,
  productId: 'prod_migrate_order',
  totalAmount: 5000,
  billingReason: 'purchase',
  metadata: { order_id: 'o_1245', tenant_id: 'tenant_proof1245' },
  subscription: null,
  customer: { externalId: 'tenant_proof1245' },
}

describe('polar plugin — events of another app on the shared org', () => {
  beforeEach(() => validateEvent.mockReset())

  it('marks Migrate\'s order unowned and names no workspace: its tenant id never reaches the database', async () => {
    const result = await handle('order.paid', migrateOrder)
    expect(result).toMatchObject({ event: 'invoice.paid', unowned: true })
    expect(result.workspaceId).toBeUndefined()
  })

  it('keeps a subscription on a product no longer configured: its workspace id says it is Studio\'s', async () => {
    // Live 2026-10-23: both active subscriptions are on the first Starter/Pro products, not the ones in env.
    const result = await handle('subscription.updated', {
      id: 'sub_legacy',
      status: 'active',
      customerId: 'cus_1',
      productId: 'prod_pro_legacy',
      currentPeriodStart: new Date('2026-10-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
      trialEnd: null,
      cancelAtPeriodEnd: false,
      metadata: { workspace_id: WORKSPACE, plan: 'pro' },
    })
    expect(result).toMatchObject({ event: 'subscription.updated', workspaceId: WORKSPACE, plan: 'pro', subscriptionId: 'sub_legacy' })
    expect(result.unowned).toBeUndefined()
  })

  it('still processes the Migrate+Studio bundle order: Studio opened that checkout on its own product', async () => {
    const result = await handle('order.paid', {
      ...migrateOrder,
      productId: 'prod_pro_bundle',
      subscriptionId: 'sub_1',
      metadata: { order_id: 'o_1245', tenant_id: 'tenant_proof1245', migrate_grant_id: 'grant-1', migrate_bundle: 'true', workspace_id: WORKSPACE, plan: 'pro' },
      customer: { externalId: WORKSPACE },
    })
    expect(result).toMatchObject({ event: 'invoice.paid', workspaceId: WORKSPACE, subscriptionId: 'sub_1' })
    expect(result.unowned).toBeUndefined()
  })
})
