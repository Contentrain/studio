import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  listWorkspaceMediaStorageBytes: vi.fn(),
  getActivePaymentAccount: vi.fn(),
  getWorkspaceById: vi.fn(),
  setPaymentAccountMetadataKey: vi.fn().mockResolvedValue(true),
  setPaymentAccountMetadataJson: vi.fn().mockResolvedValue(true),
}))
const recordMediaStorageDay = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../server/utils/providers', () => ({ useDatabaseProvider: () => db }))
vi.mock('../../server/utils/usage-metering', () => ({ recordMediaStorageDay }))
vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: 'subscription', edition: 'ee' }) }))

const GB = 1024 ** 3
const COVERED = { billable_meters: ['ai_credits_1c', 'media_storage_gb_months'], overage_on_since_media_storage: '2026-09-01T00:00:00Z' }

/**
 * Media storage is a level, so it reaches the payment meter only by being
 * sampled: one `media_storage_gb_months` event per paying workspace per UTC
 * day, carrying GB ÷ the days in its billing period.
 */
describe('daily media storage meter', () => {
  beforeEach(() => {
    vi.stubGlobal('defineNitroPlugin', (fn: unknown) => fn)
    db.listWorkspaceMediaStorageBytes.mockReset()
    db.getActivePaymentAccount.mockReset()
    // Pro (25 GB) with storage overage on since before these days, unless a test says otherwise.
    db.getWorkspaceById.mockReset().mockResolvedValue({ plan: 'pro', overage_settings: { media_storage: true } })
    recordMediaStorageDay.mockClear()
  })

  it('samples each paying workspace once for the day, with its billing period length', async () => {
    const { meterMediaStorageDay } = await import('../../server/plugins/media-storage-meter')
    const now = new Date('2026-10-09T00:40:00Z')
    db.listWorkspaceMediaStorageBytes.mockResolvedValue([
      { workspaceId: 'ws-paid', bytes: 30 * GB },
      { workspaceId: 'ws-no-customer', bytes: 2 * GB },
    ])
    db.getActivePaymentAccount.mockImplementation(async (id: string) => id === 'ws-paid'
      ? { customer_id: 'cus_1', subscription_status: 'active', current_period_start: '2026-09-21T10:00:00Z', current_period_end: '2026-10-21T10:00:00Z', plugin_metadata: COVERED }
      : { customer_id: null })

    expect(await meterMediaStorageDay(now)).toBe(1)
    expect(recordMediaStorageDay).toHaveBeenCalledOnce()
    expect(recordMediaStorageDay).toHaveBeenCalledWith({ workspaceId: 'ws-paid', day: '2026-10-09', bytes: 30 * GB, periodDays: 30 })
  })

  it('without storage overage, caps the sample at the plan: nothing past it is billed', async () => {
    const { meterMediaStorageDay } = await import('../../server/plugins/media-storage-meter')
    db.listWorkspaceMediaStorageBytes.mockResolvedValue([{ workspaceId: 'ws-1', bytes: 30 * GB }])
    db.getActivePaymentAccount.mockResolvedValue({ customer_id: 'cus_1', subscription_status: 'active', plugin_metadata: { billable_meters: ['media_storage_gb_months'] } })
    db.getWorkspaceById.mockResolvedValue({ plan: 'pro', overage_settings: { media_storage: false } })

    await meterMediaStorageDay(new Date('2026-10-09T00:40:00Z'))
    expect(recordMediaStorageDay).toHaveBeenCalledWith(expect.objectContaining({ bytes: 25 * GB }))
  })

  it('caps the day storage overage was turned on, and a locked toggle every day', async () => {
    const { meterMediaStorageDay } = await import('../../server/plugins/media-storage-meter')
    db.listWorkspaceMediaStorageBytes.mockResolvedValue([{ workspaceId: 'ws-new', bytes: 30 * GB }, { workspaceId: 'ws-trial', bytes: 30 * GB }])
    db.getActivePaymentAccount.mockImplementation(async (id: string) => id === 'ws-new'
      ? { customer_id: 'cus_1', subscription_status: 'active', plugin_metadata: { ...COVERED, overage_on_since_media_storage: '2026-10-09T00:10:00Z' } }
      : { customer_id: 'cus_2', subscription_status: 'trialing', trial_ends_at: '2026-10-20T00:00:00Z', plugin_metadata: COVERED })

    await meterMediaStorageDay(new Date('2026-10-09T00:40:00Z'))
    expect(recordMediaStorageDay).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-new', bytes: 25 * GB }))
    expect(recordMediaStorageDay).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-trial', bytes: 25 * GB }))
  })

  it('uses the calendar month for an account without a billing period', async () => {
    const { meterMediaStorageDay } = await import('../../server/plugins/media-storage-meter')
    db.listWorkspaceMediaStorageBytes.mockResolvedValue([{ workspaceId: 'ws-1', bytes: GB }])
    db.getActivePaymentAccount.mockResolvedValue({ customer_id: 'cus_1', subscription_status: null })

    await meterMediaStorageDay(new Date('2026-02-10T03:00:00Z'))
    expect(recordMediaStorageDay).toHaveBeenCalledWith(expect.objectContaining({ periodDays: 28 }))
  })

  it('skips one unreadable account and meters the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { meterMediaStorageDay } = await import('../../server/plugins/media-storage-meter')
    db.listWorkspaceMediaStorageBytes.mockResolvedValue([{ workspaceId: 'ws-bad', bytes: GB }, { workspaceId: 'ws-ok', bytes: GB }])
    db.getActivePaymentAccount.mockImplementation(async (id: string) => {
      if (id === 'ws-bad') throw new Error('connection reset')
      return { customer_id: 'cus_2' }
    })

    expect(await meterMediaStorageDay(new Date('2026-10-09T00:40:00Z'))).toBe(1)
    expect(recordMediaStorageDay).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-ok' }))
    error.mockRestore()
  })

  it('lets a failed storage listing reject: no day is recorded as empty', async () => {
    const { meterMediaStorageDay } = await import('../../server/plugins/media-storage-meter')
    db.listWorkspaceMediaStorageBytes.mockRejectedValue(new Error('db down'))
    await expect(meterMediaStorageDay(new Date())).rejects.toThrow('db down')
    expect(recordMediaStorageDay).not.toHaveBeenCalled()
  })

  it('counts a period in days, never less than one', async () => {
    const { periodDays } = await import('../../server/plugins/media-storage-meter')
    expect(periodDays({ startsAt: '2026-10-01T00:00:00Z', resetsAt: '2026-11-01T00:00:00Z' })).toBe(31)
    expect(periodDays({ startsAt: '2026-10-01T00:00:00Z', resetsAt: '2026-10-01T00:00:00Z' })).toBe(1)
  })
})
