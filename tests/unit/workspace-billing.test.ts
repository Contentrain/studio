import { beforeEach, describe, expect, it, vi } from 'vitest'

const deployment = vi.hoisted(() => ({ planSource: 'subscription' as 'subscription' | 'operator' | 'fixed' }))
vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => deployment }))
vi.mock('../../server/utils/license', () => ({
  getWorkspacePlan: (w: { plan?: string | null }) => w.plan ?? 'community',
}))

const { resolveWorkspaceBilling } = await import('../../server/utils/workspace-billing')

function dbWith(account: Record<string, unknown> | null) {
  return { getActivePaymentAccount: vi.fn(async () => account) }
}

const LEGACY_PRICES = ['ai_messages', 'api_messages', 'form_submissions', 'mcp_calls']

describe('resolveWorkspaceBilling', () => {
  beforeEach(() => {
    deployment.planSource = 'subscription'
  })

  it('an active subscription keeps its plan', async () => {
    const billing = await resolveWorkspaceBilling(
      dbWith({ subscription_status: 'active', subscription_id: 'sub_1', current_period_end: '2099-01-01T00:00:00Z' }),
      { id: 'ws-1', type: 'primary', plan: 'pro', overage_settings: {} },
    )
    expect(billing).toMatchObject({ state: 'subscribed', effectivePlan: 'pro' })
  })

  it('a workspace whose trial expired is free, whatever the plan column says', async () => {
    const billing = await resolveWorkspaceBilling(
      dbWith({ subscription_status: 'trialing', subscription_id: 'sub_1', trial_ends_at: '2020-01-01T00:00:00Z' }),
      { id: 'ws-1', type: 'primary', plan: 'pro', overage_settings: {} },
    )
    expect(billing).toMatchObject({ state: 'trial_expired', effectivePlan: 'free' })
  })

  it('refuses a locked workspace with 402 payment required when access is required', async () => {
    const expired = dbWith({ subscription_status: 'trialing', subscription_id: 'sub_1', trial_ends_at: '2020-01-01T00:00:00Z' })
    await expect(resolveWorkspaceBilling(expired, { id: 'ws-1', type: 'primary', plan: 'pro' }, { requireAccess: true }))
      .rejects.toMatchObject({
        statusCode: 402,
        message: 'billing.payment_required',
        data: { code: 'payment_required', billingState: 'trial_expired', requiresCheckout: true },
      })
  })

  it('lets an accessible workspace through when access is required', async () => {
    const active = dbWith({ subscription_status: 'active', subscription_id: 'sub_1' })
    await expect(resolveWorkspaceBilling(active, { id: 'ws-1', type: 'primary', plan: 'pro' }, { requireAccess: true }))
      .resolves.toMatchObject({ state: 'subscribed', effectivePlan: 'pro' })
  })

  it('turns off overage the subscription cannot bill', async () => {
    const billing = await resolveWorkspaceBilling(
      dbWith({ subscription_status: 'active', subscription_id: 'sub_1', plugin_metadata: { billable_meters: LEGACY_PRICES } }),
      { id: 'ws-1', type: 'primary', plan: 'pro', overage_settings: { api_messages: true, mcp_calls: true } },
    )
    expect(billing.overageSettings).toEqual({ api_messages: false, mcp_calls: true })
  })

  it('operator/fixed profiles take the plan from the row and lock nothing', async () => {
    deployment.planSource = 'operator'
    const db = dbWith(null)
    const billing = await resolveWorkspaceBilling(db, { id: 'ws-1', plan: 'enterprise', overage_settings: { api_messages: true } })
    expect(billing).toEqual({ state: 'subscribed', effectivePlan: 'enterprise', overageSettings: { api_messages: true } })
    expect(db.getActivePaymentAccount).not.toHaveBeenCalled()
  })
})

describe('resolveConversationModel', () => {
  it('runs a key stored with a retired model on the default', async () => {
    const { resolveConversationModel, DEFAULT_CONVERSATION_API_MODEL } = await import('../../server/utils/conversation-keys')
    expect(DEFAULT_CONVERSATION_API_MODEL).toBe('claude-sonnet-5')
    expect(resolveConversationModel('claude-sonnet-4-20250514')).toBe('claude-sonnet-5')
    expect(resolveConversationModel(null)).toBe('claude-sonnet-5')
    expect(resolveConversationModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
  })
})
