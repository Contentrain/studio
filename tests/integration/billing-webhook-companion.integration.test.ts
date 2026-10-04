import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

/**
 * A yearly plan's companion usage subscription (server/utils/companion-subscription.ts) through the billing
 * webhook: opened with the plan subscription, recorded beside the account, never writing the account's own
 * fields, and ended with the plan.
 */
describe('billing webhook: companion usage subscription', () => {
  const upsertPaymentAccount = vi.fn().mockResolvedValue({})
  const archiveActivePaymentAccount = vi.fn().mockResolvedValue(undefined)
  const updateWorkspace = vi.fn().mockResolvedValue({})
  const getActivePaymentAccount = vi.fn()
  const getWorkspaceById = vi.fn()
  const markWorkspaceTrialConsumed = vi.fn().mockResolvedValue(undefined)
  const setPaymentAccountMetadataKey = vi.fn(async ({ when }: { when: unknown }) => when === 'different')
  const setPaymentAccountCreditUnit = vi.fn().mockResolvedValue(false)
  const ensureCompanionSubscription = vi.fn()
  const cancelSubscription = vi.fn()
  let handleWebhookMock: ReturnType<typeof vi.fn>

  const yearlyAccount = (metadata: Record<string, unknown> = {}) => ({
    workspace_id: 'ws-1', provider: 'polar', customer_id: 'cus_1', subscription_id: 'sub_1', subscription_status: 'active', plan: 'pro',
    current_period_start: '2026-10-01T00:00:00Z', current_period_end: '2027-10-01T00:00:00Z', trial_ends_at: null, cancel_at_period_end: false,
    grace_period_ends_at: null, plugin_metadata: metadata,
  })

  beforeEach(() => {
    vi.resetModules()
    handleWebhookMock = vi.fn()
    vi.stubGlobal('redeemMigrateGrant', vi.fn())
    vi.stubGlobal('isDuplicateBundleSubscription', vi.fn().mockResolvedValue(false))
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('readRawBody', vi.fn().mockResolvedValue('{}'))
    vi.stubGlobal('getRequestHeaders', vi.fn().mockReturnValue({}))
    vi.stubGlobal('getRouterParam', vi.fn().mockReturnValue('polar'))
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({ polar: {} }))
    vi.stubGlobal('useEmailProvider', vi.fn().mockReturnValue(null))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      upsertPaymentAccount, archiveActivePaymentAccount, updateWorkspace, getActivePaymentAccount, getWorkspaceById,
      markWorkspaceTrialConsumed, setPaymentAccountMetadataKey, setPaymentAccountCreditUnit,
    }))
    getWorkspaceById.mockResolvedValue({ id: 'ws-1', overage_settings: { ai_messages: false } })
    ensureCompanionSubscription.mockReset().mockResolvedValue({ subscriptionId: 'sub_c1', created: true })
    cancelSubscription.mockReset().mockResolvedValue('canceled')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const fn of [upsertPaymentAccount, archiveActivePaymentAccount, updateWorkspace, getActivePaymentAccount, getWorkspaceById, markWorkspaceTrialConsumed, setPaymentAccountCreditUnit]) fn.mockReset()
    upsertPaymentAccount.mockResolvedValue({})
    setPaymentAccountMetadataKey.mockClear()
  })

  async function load() {
    const paymentModule = await import('../../server/providers/payment')
    paymentModule.bootstrapPaymentPlugins()
    const { __resetRegistryForTests } = await import('../../server/providers/payment/registry')
    __resetRegistryForTests()
    paymentModule.registerPlugin({
      key: 'polar',
      label: 'Polar',
      isConfigured: () => true,
      create: () => ({
        createCheckoutSession: vi.fn(), createPortalSession: vi.fn(), handleWebhook: handleWebhookMock, cancelSubscription,
        createBundleCheckout: vi.fn(), moveBundleSubscriptionToList: vi.fn(), ingestUsageEvent: vi.fn(), ensureCompanionSubscription,
      }),
    })
    return (await import('../../server/api/billing/webhook/[provider].post.ts')).default
  }
  const post = async () => (await load())({ context: {} } as never)

  const planCreated = {
    event: 'subscription.created', workspaceId: 'ws-1', plan: 'pro', productId: 'prod_pro_y', customerId: 'cus_1', subscriptionId: 'sub_1',
    subscriptionStatus: 'active', currentPeriodStart: '2026-10-01T00:00:00Z', currentPeriodEnd: '2027-10-01T00:00:00Z', billableMeters: [],
  }

  it('opens the companion when a yearly plan subscription is created, and records it on the account', async () => {
    handleWebhookMock.mockResolvedValue(planCreated)
    await post()
    expect(ensureCompanionSubscription).toHaveBeenCalledWith({
      workspaceId: 'ws-1', plan: 'pro', customerId: 'cus_1', parentSubscriptionId: 'sub_1', parentProductId: 'prod_pro_y',
    })
    expect(setPaymentAccountMetadataKey).toHaveBeenCalledWith({ workspaceId: 'ws-1', key: 'companion_subscription_id', value: 'sub_c1', when: 'different' })
  })

  it('a companion that cannot be opened never fails the plan subscription\'s webhook', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    handleWebhookMock.mockResolvedValue(planCreated)
    ensureCompanionSubscription.mockRejectedValue(new Error('polar down'))
    expect(await post()).toEqual({ received: true })
    expect(upsertPaymentAccount).toHaveBeenCalled()
    log.mockRestore()
  })

  it('records a companion event beside the account and writes none of the account\'s own fields', async () => {
    getActivePaymentAccount.mockResolvedValue(yearlyAccount({ overage_suspended: ['ai_messages'], billable_meters: [] }))
    handleWebhookMock.mockResolvedValue({
      event: 'subscription.created', companion: true, workspaceId: 'ws-1', plan: 'pro', productId: 'prod_pro_c', customerId: 'cus_1',
      subscriptionId: 'sub_c1', subscriptionStatus: 'active', currentPeriodStart: '2026-10-05T00:00:00Z', currentPeriodEnd: '2026-11-05T00:00:00Z',
      billableMeters: ['ai_credits', 'api_credits'],
    })
    await post()
    expect(setPaymentAccountMetadataKey).toHaveBeenCalledWith({ workspaceId: 'ws-1', key: 'companion_subscription_id', value: 'sub_c1', when: 'different' })
    expect(setPaymentAccountMetadataKey).toHaveBeenCalledWith({ workspaceId: 'ws-1', key: 'companion_billable_meters', value: 'ai_credits,api_credits', when: 'different' })
    // No plan write, no archive, no trial bookkeeping, no creation of a second companion.
    expect(updateWorkspace).not.toHaveBeenCalledWith('', 'ws-1', expect.objectContaining({ plan: expect.anything() }))
    expect(archiveActivePaymentAccount).not.toHaveBeenCalled()
    expect(markWorkspaceTrialConsumed).not.toHaveBeenCalled()
    expect(ensureCompanionSubscription).not.toHaveBeenCalled()
  })

  it('lines the overage toggles up again once the companion prices the meters, keeping the row\'s own values', async () => {
    getActivePaymentAccount
      .mockResolvedValueOnce(yearlyAccount({ overage_suspended: ['ai_messages'], billable_meters: [] }))
      .mockResolvedValueOnce(yearlyAccount({ overage_suspended: ['ai_messages'], billable_meters: [], companion_subscription_id: 'sub_c1', companion_billable_meters: 'ai_credits,api_credits' }))
    handleWebhookMock.mockResolvedValue({ event: 'subscription.updated', companion: true, workspaceId: 'ws-1', subscriptionId: 'sub_c1', customerId: 'cus_1', subscriptionStatus: 'active', billableMeters: ['ai_credits', 'api_credits'] })
    await post()
    expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', { overage_settings: { ai_messages: true } })
    const written = upsertPaymentAccount.mock.calls[0]![0]
    expect(written).toMatchObject({ subscriptionId: 'sub_1', subscriptionStatus: 'active', plan: 'pro', customerId: 'cus_1', currentPeriodEnd: '2027-10-01T00:00:00Z' })
    expect(written.preserveMetadataKeys).toEqual(expect.arrayContaining(['companion_subscription_id', 'companion_billable_meters']))
    expect(written.pluginMetadata.overage_suspended).toBeUndefined()
  })

  it('ignores a late event about a companion the account no longer has', async () => {
    getActivePaymentAccount.mockResolvedValue(yearlyAccount({ companion_subscription_id: 'sub_c_current' }))
    handleWebhookMock.mockResolvedValue({ event: 'subscription.canceled', companion: true, workspaceId: 'ws-1', subscriptionId: 'sub_c_old', customerId: 'cus_1' })
    await post()
    expect(setPaymentAccountMetadataKey).not.toHaveBeenCalled()
    expect(upsertPaymentAccount).not.toHaveBeenCalled()
  })

  it('an ended companion is forgotten without ending the plan', async () => {
    getActivePaymentAccount.mockResolvedValue(yearlyAccount({ companion_subscription_id: 'sub_c1', companion_billable_meters: 'ai_credits' }))
    handleWebhookMock.mockResolvedValue({ event: 'subscription.canceled', companion: true, workspaceId: 'ws-1', subscriptionId: 'sub_c1', customerId: 'cus_1', subscriptionStatus: 'canceled' })
    await post()
    expect(setPaymentAccountMetadataKey).toHaveBeenCalledWith({ workspaceId: 'ws-1', key: 'companion_subscription_id', value: '', when: 'different' })
    expect(setPaymentAccountMetadataKey).toHaveBeenCalledWith({ workspaceId: 'ws-1', key: 'companion_billable_meters', value: '', when: 'different' })
    expect(archiveActivePaymentAccount).not.toHaveBeenCalled()
    expect(updateWorkspace).not.toHaveBeenCalledWith('', 'ws-1', { plan: 'free', trial_reminder_stage: 0 })
  })

  it('a companion\'s usage invoice is not the plan\'s payment', async () => {
    getActivePaymentAccount.mockResolvedValue(yearlyAccount({ companion_subscription_id: 'sub_c1' }))
    handleWebhookMock.mockResolvedValue({ event: 'invoice.paid', companion: true, workspaceId: 'ws-1', subscriptionId: 'sub_c1', customerId: 'cus_1', invoiceId: 'ord_9' })
    expect(await post()).toEqual({ received: true })
    expect(upsertPaymentAccount).not.toHaveBeenCalled()
    expect(setPaymentAccountMetadataKey).not.toHaveBeenCalled()
  })

  it('a plan subscription update keeps what its companion recorded, and opens the companion when there is none', async () => {
    getActivePaymentAccount.mockResolvedValue(yearlyAccount({ companion_subscription_id: 'sub_c1', companion_billable_meters: 'ai_credits' }))
    handleWebhookMock.mockResolvedValue({ ...planCreated, event: 'subscription.updated' })
    await post()
    expect(upsertPaymentAccount.mock.calls[0]![0].preserveMetadataKeys).toEqual(expect.arrayContaining(['companion_subscription_id', 'companion_billable_meters']))
    expect(ensureCompanionSubscription).not.toHaveBeenCalled()

    getActivePaymentAccount.mockResolvedValue(yearlyAccount({}))
    await post()
    expect(ensureCompanionSubscription).toHaveBeenCalledTimes(1)
  })

  it('cancels the companion when the plan subscription ends', async () => {
    getActivePaymentAccount.mockResolvedValue(yearlyAccount({ companion_subscription_id: 'sub_c1' }))
    handleWebhookMock.mockResolvedValue({ event: 'subscription.canceled', workspaceId: 'ws-1', subscriptionId: 'sub_1', customerId: 'cus_1', subscriptionStatus: 'canceled' })
    await post()
    expect(cancelSubscription).toHaveBeenCalledWith('sub_c1')
    expect(archiveActivePaymentAccount).toHaveBeenCalledWith('ws-1')
  })

  it('a companion that will not cancel is an ALARM, and the plan still ends', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    getActivePaymentAccount.mockResolvedValue(yearlyAccount({ companion_subscription_id: 'sub_c1' }))
    cancelSubscription.mockRejectedValue(new Error('polar down'))
    handleWebhookMock.mockResolvedValue({ event: 'subscription.canceled', workspaceId: 'ws-1', subscriptionId: 'sub_1', customerId: 'cus_1', subscriptionStatus: 'canceled' })
    await post()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[companion] ALARM could not cancel'), expect.any(Error))
    expect(archiveActivePaymentAccount).toHaveBeenCalledWith('ws-1')
    log.mockRestore()
  })
})
