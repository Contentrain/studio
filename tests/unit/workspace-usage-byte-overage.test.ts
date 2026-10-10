import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeWorkspaceUsage } from '../../server/utils/workspace-usage'
import { usagePeriodFrom } from '../../server/utils/usage-period'

/**
 * CDN origin transfer ($0.15/GB) and media storage ($0.25/GB-month) are
 * charged past the plan once overage is on. The usage screen quotes the same
 * amount the meter bills: units past the plan × the catalogue price.
 */
const NOW = new Date('2026-09-23T12:00:00Z')
const GB = 1024 ** 3

function db(cdnGb: number) {
  return {
    getWorkspaceMonthlyAIUsage: vi.fn().mockResolvedValue(0),
    getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(0),
    countMonthlySubmissions: vi.fn().mockResolvedValue(0),
    getWorkspaceMonthlyCDNBandwidth: vi.fn().mockResolvedValue(cdnGb * GB),
    getWorkspaceMonthlyMcpCloudUsage: vi.fn().mockResolvedValue(0),
    countMonthlyComments: vi.fn().mockResolvedValue(0),
  }
}

const base = { workspaceId: 'ws-1', plan: 'pro', period: usagePeriodFrom(null, NOW), now: NOW }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CDN and storage overage charge', () => {
  beforeEach(() => {
    vi.stubGlobal('useRuntimeConfig', () => ({ cdn: { originMeter: true, storageMeter: true } }))
  })

  it('charges each GB past the plan at the catalogue price when overage is on', async () => {
    // Pro: 60 GB CDN, 25 GB storage.
    const usage = await computeWorkspaceUsage(db(70) as never, {
      ...base,
      overageSettings: { cdn_bandwidth: true, media_storage: true },
      storageBytes: 30 * GB,
    })
    const cdn = usage.categories.find(c => c.key === 'cdn_bandwidth')!
    const storage = usage.categories.find(c => c.key === 'media_storage')!
    expect(cdn).toMatchObject({ overageSellable: true, overageEnabled: true, overageUnits: 10, overageUnitPrice: 0.15, overageAmount: 1.5, overageCeiling: 600 })
    expect(storage).toMatchObject({ overageSellable: true, overageEnabled: true, overageUnits: 5, overageUnitPrice: 0.25, overageAmount: 1.25, overageCeiling: 250 })
    expect(usage.totalOverageAmount).toBe(2.75)
    // Storage is a level: projected at today's level. CDN is projected over its window.
    expect(usage.projectedOverageAmount).toBeGreaterThan(2.75)
  })

  it('quotes nothing while overage is off, but shows the price and ceiling before it is turned on', async () => {
    const usage = await computeWorkspaceUsage(db(70) as never, { ...base, overageSettings: {}, storageBytes: 30 * GB })
    const cdn = usage.categories.find(c => c.key === 'cdn_bandwidth')!
    expect(cdn).toMatchObject({ overageSellable: true, overageEnabled: false, overageUnits: 0, overageAmount: 0, overageUnitPrice: 0.15, overageCeiling: 600 })
    expect(usage.totalOverageAmount).toBe(0)
  })

  it('quotes nothing for a toggle the subscription cannot bill yet', async () => {
    const usage = await computeWorkspaceUsage(db(70) as never, {
      ...base,
      overageSettings: { cdn_bandwidth: true },
      storageBytes: 0,
      overageLocks: { cdn_bandwidth: { reason: 'not_in_subscription', until: null } },
    })
    const cdn = usage.categories.find(c => c.key === 'cdn_bandwidth')!
    expect(cdn).toMatchObject({ overageEnabled: false, overageAmount: 0 })
  })

  it('has no ceiling on the meters that are not bounded', async () => {
    const usage = await computeWorkspaceUsage(db(0) as never, { ...base, overageSettings: {}, storageBytes: 0 })
    expect(usage.categories.find(c => c.key === 'ai_messages')!.overageCeiling).toBeNull()
  })
})

describe('CDN and storage with the meter flags off', () => {
  it('stay a fixed limit: not sellable, no price, no ceiling, nothing quoted', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ cdn: { originMeter: false, storageMeter: false } }))
    const usage = await computeWorkspaceUsage(db(70) as never, { ...base, overageSettings: { cdn_bandwidth: true, media_storage: true }, storageBytes: 30 * GB })
    for (const key of ['cdn_bandwidth', 'media_storage'])
      expect(usage.categories.find(c => c.key === key)).toMatchObject({ overageSellable: false, overageEnabled: false, overageUnitPrice: 0, overageAmount: 0, overageCeiling: null })
    expect(usage.totalOverageAmount).toBe(0)
  })
})
