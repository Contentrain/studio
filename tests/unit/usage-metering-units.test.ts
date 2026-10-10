import { beforeEach, describe, expect, it, vi } from 'vitest'

const enqueueUsageEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../server/utils/license', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/utils/license')>()),
  isBillingConfigured: () => true,
}))

/**
 * A credit is sent to the meter its subscription is priced on: a pre-v2
 * subscription's $0.03 credits to `ai_credits`, a v2 one's $0.01 credits to
 * `ai_credits_1c`. Sending either to the other's meter would bill 3× too much
 * or too little.
 */
describe('usage metering — credit meters by unit', () => {
  beforeEach(() => {
    enqueueUsageEvent.mockClear()
    vi.stubGlobal('useDatabaseProvider', () => ({ enqueueUsageEvent }))
  })

  it('sends AI and API credits to the meter of the account\'s unit', async () => {
    const { recordAIUsage, recordAPIUsage } = await import('../../server/utils/usage-metering')
    await recordAIUsage({ workspaceId: 'ws', count: 7, userId: 'u', month: '2026-09-15', creditUnit: '0.03' })
    await recordAIUsage({ workspaceId: 'ws', count: 21, userId: 'u', month: '2026-09-15', creditUnit: '0.01' })
    await recordAPIUsage({ workspaceId: 'ws', count: 3, apiKeyId: 'k', month: '2026-09-15', creditUnit: '0.03' })
    await recordAPIUsage({ workspaceId: 'ws', count: 9, apiKeyId: 'k', month: '2026-09-15', creditUnit: '0.01' })
    expect(enqueueUsageEvent.mock.calls.map(([e]) => [e.meterName, e.value])).toEqual([
      ['ai_credits', 7],
      ['ai_credits_1c', 21],
      ['api_credits', 3],
      ['api_credits_1c', 9],
    ])
  })
})

/**
 * The two byte meters send the unit the plan sells, so the plan's GB is the
 * Polar allowance as is: CDN origin transfer in GB per day, storage in
 * GB-months (a day's GB over the days in its period).
 */
describe('usage metering — CDN and storage in plan units', () => {
  const GB = 1024 ** 3

  beforeEach(() => {
    enqueueUsageEvent.mockClear()
    vi.stubGlobal('useDatabaseProvider', () => ({ enqueueUsageEvent }))
  })

  it('sends a day of CDN origin transfer in GB, keyed by workspace and day', async () => {
    const { recordCDNOriginUsage } = await import('../../server/utils/usage-metering')
    await recordCDNOriginUsage({ workspaceId: 'ws', day: '2026-10-08', bytes: 1.5 * GB })
    expect(enqueueUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      meterName: 'cdn_origin_gb',
      value: 1.5,
      idempotencyKey: 'cdn-origin:ws:2026-10-08',
    }))
  })

  it('sends a day of storage as GB over the period\'s days, keyed by workspace and day', async () => {
    const { recordMediaStorageDay } = await import('../../server/utils/usage-metering')
    await recordMediaStorageDay({ workspaceId: 'ws', day: '2026-10-08', bytes: 30 * GB, periodDays: 30 })
    expect(enqueueUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      meterName: 'media_storage_gb_months',
      value: 1,
      idempotencyKey: 'storage-gbm:ws:2026-10-08',
      metadata: { day: '2026-10-08', bytes: 30 * GB, period_days: 30 },
    }))
  })

  it('sums a full period of daily samples to the average GB stored (GB-months)', async () => {
    const { storageGbMonthsForDay } = await import('../../server/utils/usage-metering')
    // 31-day period: 10 days at 20 GB, 21 days at 40 GB → average 33.548 GB.
    const days = [...Array.from({ length: 10 }, () => 20 * GB), ...Array.from({ length: 21 }, () => 40 * GB)]
    const sum = days.reduce((total, bytes) => total + storageGbMonthsForDay(bytes, 31), 0)
    expect(sum).toBeCloseTo((10 * 20 + 21 * 40) / 31, 4)
    // Pro includes 25 GB-months; overage is billed on the rest at $0.25.
    expect(Math.round((sum - 25) * 0.25 * 100) / 100).toBe(2.14)
    expect(storageGbMonthsForDay(0, 30)).toBe(0)
  })
})
