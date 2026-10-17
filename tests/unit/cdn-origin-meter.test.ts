import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  listWorkspaceCDNBandwidthForDay: vi.fn(),
  getWorkspaceById: vi.fn(),
  getActivePaymentAccount: vi.fn(),
  getWorkspaceMonthlyCDNBandwidth: vi.fn(),
  setPaymentAccountMetadataKey: vi.fn().mockResolvedValue(true),
  setPaymentAccountMetadataJson: vi.fn().mockResolvedValue(true),
}))
const recordCDNOriginUsage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../server/utils/providers', () => ({ useDatabaseProvider: () => db }))
vi.mock('../../server/utils/usage-metering', () => ({ recordCDNOriginUsage }))
vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: 'subscription', edition: 'ee' }) }))

const GB = 1024 ** 3
const now = new Date('2026-10-01T00:30:00Z')

function account(metadata: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    customer_id: 'cus_1',
    subscription_status: 'active',
    current_period_start: '2026-09-15T00:00:00Z',
    current_period_end: '2026-10-15T00:00:00Z',
    plugin_metadata: { billable_meters: ['ai_credits_1c', 'cdn_origin_gb'], ...metadata },
    ...extra,
  }
}

describe('daily CDN origin meter', () => {
  beforeEach(() => {
    vi.stubGlobal('defineNitroPlugin', (fn: unknown) => fn)
    for (const fn of Object.values(db)) fn.mockClear()
    recordCDNOriginUsage.mockClear()
    db.listWorkspaceCDNBandwidthForDay.mockImplementation(async (day: string) =>
      day === '2026-09-30' ? [{ workspaceId: 'ws-1', bytes: 1 * GB }] : [])
    db.getWorkspaceMonthlyCDNBandwidth.mockResolvedValue(2.5 * GB)
  })

  it('meters each finished UTC day once per workspace, never the day in progress', async () => {
    const { finishedDays, meterCdnOriginDays } = await import('../../server/plugins/cdn-origin-meter')
    expect(finishedDays(now, 2)).toEqual(['2026-09-29', '2026-09-30'])

    db.getWorkspaceById.mockResolvedValue({ plan: 'pro', overage_settings: { cdn_bandwidth: true } })
    db.getActivePaymentAccount.mockResolvedValue(account({ overage_on_since_cdn_bandwidth: '2026-09-01T00:00:00Z' }))
    expect(await meterCdnOriginDays(now)).toBe(1)
    // Covered by overage for the whole day: billed in full.
    expect(recordCDNOriginUsage).toHaveBeenCalledWith({ workspaceId: 'ws-1', day: '2026-09-30', bytes: 1 * GB })
    expect(db.getWorkspaceMonthlyCDNBandwidth).not.toHaveBeenCalled()
  })

  it('without overage, reports only what still fits under the plan: the grace stays unbilled', async () => {
    const { meterCdnOriginDays } = await import('../../server/plugins/cdn-origin-meter')
    db.getWorkspaceById.mockResolvedValue({ plan: 'starter', overage_settings: {} })
    db.getActivePaymentAccount.mockResolvedValue(account())

    await meterCdnOriginDays(now)
    // Starter has 3 GB; 2.5 GB were used earlier in the period.
    expect(db.getWorkspaceMonthlyCDNBandwidth).toHaveBeenCalledWith('ws-1', expect.any(String), { from: '2026-09-15T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' })
    expect(recordCDNOriginUsage).toHaveBeenCalledWith({ workspaceId: 'ws-1', day: '2026-09-30', bytes: 0.5 * GB })
  })

  it('does not bill a looked-back day past the plan when overage was turned on after it began', async () => {
    const { meterCdnOriginDays } = await import('../../server/plugins/cdn-origin-meter')
    db.getWorkspaceById.mockResolvedValue({ plan: 'starter', overage_settings: { cdn_bandwidth: true } })
    db.getActivePaymentAccount.mockResolvedValue(account({ overage_on_since_cdn_bandwidth: '2026-09-30T18:00:00Z' }))
    db.getWorkspaceMonthlyCDNBandwidth.mockResolvedValue(4 * GB)

    await meterCdnOriginDays(now)
    expect(recordCDNOriginUsage).toHaveBeenCalledWith({ workspaceId: 'ws-1', day: '2026-09-30', bytes: 0 })
  })

  it('caps a day whose toggle is on but locked (trial)', async () => {
    const { meterCdnOriginDays } = await import('../../server/plugins/cdn-origin-meter')
    db.getWorkspaceById.mockResolvedValue({ plan: 'starter', overage_settings: { cdn_bandwidth: true } })
    db.getActivePaymentAccount.mockResolvedValue(account({ overage_on_since_cdn_bandwidth: '2026-09-01T00:00:00Z' }, { subscription_status: 'trialing', trial_ends_at: '2026-10-05T00:00:00Z' }))

    await meterCdnOriginDays(now)
    expect(recordCDNOriginUsage).toHaveBeenCalledWith({ workspaceId: 'ws-1', day: '2026-09-30', bytes: 0.5 * GB })
  })

  it('skips a workspace whose billing cannot be read; the lookback retries its day', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { meterCdnOriginDays } = await import('../../server/plugins/cdn-origin-meter')
    db.getWorkspaceById.mockRejectedValue(new Error('connection reset'))

    expect(await meterCdnOriginDays(now)).toBe(0)
    expect(recordCDNOriginUsage).not.toHaveBeenCalled()
    error.mockRestore()
  })
})
