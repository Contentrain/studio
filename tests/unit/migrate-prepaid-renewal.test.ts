import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string, data?: unknown }) {
  return Object.assign(new Error(input.message), input)
}

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2027-10-20T00:00:00Z')
const ENDS = '2027-11-04T10:00:00.000Z'
const workspace = { id: 'ws-1', slug: 'team', name: 'Team', prepaid_until: ENDS }

describe('"Keep Studio" after a prepaid year', () => {
  let createCheckoutSession: ReturnType<typeof vi.fn>
  let getLivePrepaidGrant: ReturnType<typeof vi.fn>
  let getWorkspaceById: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({ public: { siteUrl: 'https://studio.example.com' } }))
    vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({ allowed: true, remaining: 0, retryAfterMs: 0 }))
    createCheckoutSession = vi.fn().mockResolvedValue({ url: 'https://pay/c', sessionId: 'co_1' })
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({ createCheckoutSession }))
    getLivePrepaidGrant = vi.fn().mockResolvedValue({ id: 'grant-1', prepaid_ends_at: ENDS, renewal_subscription_id: null })
    getWorkspaceById = vi.fn().mockResolvedValue({ prepaid_until: ENDS })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getLivePrepaidGrant,
      getWorkspaceById,
      getActivePaymentAccount: vi.fn().mockResolvedValue(null),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function keep(input: Partial<{ now: number, plan: 'starter' | 'pro', workspace: typeof workspace }> = {}) {
    const { startPrepaidRenewalCheckout } = await import('../../server/utils/migrate-prepaid-renewal')
    return startPrepaidRenewalCheckout({ workspace, plan: 'pro', customerEmail: 'owner@example.com', now: NOW, ...input })
  }

  it('sells the yearly plan with a trial that ends with the year, tagged as a renewal and not a grant', async () => {
    await expect(keep()).resolves.toMatchObject({ url: 'https://pay/c' })
    // 15 days 10 hours left → 16 days, nothing charged before the year ends.
    expect(createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      plan: 'pro',
      interval: 'year',
      withTrial: true,
      trialDays: 16,
      metadata: { migrate_renewal_grant_id: 'grant-1' },
    }))
    // The prepaid guard of an ordinary checkout is not what decides here.
    expect(getWorkspaceById).not.toHaveBeenCalled()
  })

  it('opens 30 days before the end, not earlier', async () => {
    const opens = Date.parse(ENDS) - 30 * DAY
    await expect(keep({ now: opens - 1000 })).rejects.toMatchObject({ statusCode: 409, data: { code: 'renewal_not_open' } })
    await expect(keep({ now: opens })).resolves.toBeTruthy()
    expect(createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ trialDays: 30 }))
  })

  it('refuses a second renewal', async () => {
    getLivePrepaidGrant.mockResolvedValue({ id: 'grant-1', prepaid_ends_at: ENDS, renewal_subscription_id: 'sub_9' })
    await expect(keep()).rejects.toMatchObject({ statusCode: 409, data: { code: 'renewal_scheduled' } })
    expect(createCheckoutSession).not.toHaveBeenCalled()
  })

  it('refuses when the workspace holds no live year, or the grant is not the year it holds', async () => {
    await expect(keep({ workspace: { ...workspace, prepaid_until: '2027-10-01T00:00:00.000Z' } })).rejects.toMatchObject({ data: { code: 'prepaid_not_active' } })
    expect(getLivePrepaidGrant).not.toHaveBeenCalled()

    getLivePrepaidGrant.mockResolvedValue({ id: 'grant-0', prepaid_ends_at: '2027-11-01T00:00:00.000Z', renewal_subscription_id: null })
    await expect(keep()).rejects.toMatchObject({ data: { code: 'prepaid_not_active' } })

    getLivePrepaidGrant.mockResolvedValue(null)
    await expect(keep()).rejects.toMatchObject({ data: { code: 'prepaid_not_active' } })
    expect(createCheckoutSession).not.toHaveBeenCalled()
  })

  it('the trial is at least a day in the last hours of the year', async () => {
    const { prepaidRenewalTrialDays } = await import('../../server/utils/migrate-prepaid-renewal')
    expect(prepaidRenewalTrialDays(ENDS, Date.parse(ENDS) - 60_000)).toBe(1)
    expect(prepaidRenewalTrialDays(ENDS, Date.parse(ENDS) - 40 * DAY)).toBe(30)
  })
})

describe('an ordinary checkout during a prepaid year', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is refused with the prepaid message, pointing to "Keep Studio"', async () => {
    vi.resetModules()
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
    const createCheckoutSession = vi.fn()
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({ createCheckoutSession }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getWorkspaceById: vi.fn().mockResolvedValue({ prepaid_until: new Date(Date.now() + DAY).toISOString() }),
    }))
    const { startPlanCheckout } = await import('../../server/utils/plan-checkout')
    await expect(startPlanCheckout({
      workspace: { id: 'ws-1', slug: 'team', name: 'Team' },
      plan: 'pro',
      customerEmail: 'owner@example.com',
      withTrial: false,
      successPath: '/ok',
      cancelPath: '/back',
    })).rejects.toMatchObject({ statusCode: 409, message: 'billing.prepaid_active', data: { code: 'prepaid_active' } })
    expect(createCheckoutSession).not.toHaveBeenCalled()
  })
})
