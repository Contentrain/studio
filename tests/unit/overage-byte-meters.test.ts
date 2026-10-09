import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERAGE_ABUSE_CEILING_RATIO, getEffectiveLimit, isOverageEnabled, isOverageSellable, overageCeiling } from '../../server/utils/overage'
import { USAGE_METERS, USAGE_METER_LIST } from '../../shared/utils/usage-meters'

/**
 * CDN origin transfer and media storage are sold past the plan (founder,
 * 2026-10-09): billed per GB / per GB-month once the workspace turns the
 * switch on, and bounded by an abuse ceiling of 10x the plan. With the
 * switch off the limit holds as before.
 */
describe('CDN and storage overage', () => {
  const SOFT_CAP_MAX = 2_147_483_647
  const GB = 1024 ** 3
  const bothOn = { cdn_bandwidth: true, media_storage: true, ai_messages: true }

  // Both meters' events on (NUXT_CDN_ORIGIN_METER / NUXT_CDN_STORAGE_METER).
  beforeEach(() => {
    vi.stubGlobal('useRuntimeConfig', () => ({ cdn: { originMeter: true, storageMeter: true } }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sells every metered limit', () => {
    for (const key of ['cdn.bandwidth_gb', 'media.storage_gb', 'ai.messages_per_month', 'api.messages_per_month', 'api.mcp_calls_per_month', 'forms.submissions_per_month'])
      expect(isOverageSellable(key), key).toBe(true)
  })

  it('derives that from the meter manifest, not a second list', () => {
    expect(USAGE_METER_LIST.every(m => m.overageBillable)).toBe(true)
    expect(USAGE_METERS.CDN_ORIGIN_GB.overageBillable).toBe(true)
    expect(USAGE_METERS.MEDIA_STORAGE_GB_MONTHS.overageBillable).toBe(true)
  })

  it('raises the cap to the abuse ceiling, not unbounded', () => {
    expect(OVERAGE_ABUSE_CEILING_RATIO['cdn.bandwidth_gb']).toBe(10)
    expect(OVERAGE_ABUSE_CEILING_RATIO['media.storage_gb']).toBe(10)
    expect(getEffectiveLimit(60, 'cdn.bandwidth_gb', bothOn)).toBe(600)
    expect(getEffectiveLimit(3, 'cdn.bandwidth_gb', bothOn)).toBe(30)
    expect(getEffectiveLimit(25 * GB, 'media.storage_gb', bothOn)).toBe(250 * GB)
    expect(isOverageEnabled('cdn.bandwidth_gb', bothOn)).toBe(true)
    expect(isOverageEnabled('media.storage_gb', bothOn)).toBe(true)
  })

  it('keeps the plan limit while the switch is off', () => {
    expect(getEffectiveLimit(60, 'cdn.bandwidth_gb', {})).toBe(60)
    expect(getEffectiveLimit(5 * GB, 'media.storage_gb', { ai_messages: true })).toBe(5 * GB)
  })

  it('leaves the other meters on the int32 soft cap', () => {
    expect(getEffectiveLimit(350, 'ai.messages_per_month', bothOn)).toBe(SOFT_CAP_MAX)
    expect(getEffectiveLimit(350, 'ai.messages_per_month', {})).toBe(350)
  })

  it('leaves an unlimited plan unlimited', () => {
    // Enterprise: the soft cap keeps the RPC integer-typed.
    expect(getEffectiveLimit(Infinity, 'cdn.bandwidth_gb', {})).toBe(SOFT_CAP_MAX)
    expect(overageCeiling(Infinity, 'cdn.bandwidth_gb')).toBe(Infinity)
  })

  it('names the ceiling in the limit unit, and none where there is none', () => {
    expect(overageCeiling(60, 'cdn.bandwidth_gb')).toBe(600)
    expect(overageCeiling(25, 'media.storage_gb')).toBe(250)
    expect(overageCeiling(350, 'ai.messages_per_month')).toBe(Infinity)
  })
})

/**
 * A meter fed by a background job sends nothing while its flag is off, so
 * its overage would be served and never invoiced. Flag off = the hard limit
 * of before, whatever the workspace has toggled.
 */
describe('CDN and storage overage with the meter flag off', () => {
  const GB = 1024 ** 3
  const bothOn = { cdn_bandwidth: true, media_storage: true, ai_messages: true }
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is not sold, and the toggle raises nothing', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ cdn: { originMeter: false, storageMeter: false } }))
    expect(isOverageSellable('cdn.bandwidth_gb')).toBe(false)
    expect(isOverageSellable('media.storage_gb')).toBe(false)
    expect(getEffectiveLimit(60, 'cdn.bandwidth_gb', bothOn)).toBe(60)
    expect(getEffectiveLimit(25 * GB, 'media.storage_gb', bothOn)).toBe(25 * GB)
    expect(isOverageEnabled('cdn.bandwidth_gb', bothOn)).toBe(false)
    // Meters fed by the request itself are unaffected.
    expect(isOverageSellable('ai.messages_per_month')).toBe(true)
  })

  it('follows each flag on its own, and reads an env string "true" as on', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ cdn: { originMeter: 'true', storageMeter: false } }))
    expect(isOverageSellable('cdn.bandwidth_gb')).toBe(true)
    expect(isOverageSellable('media.storage_gb')).toBe(false)
  })

  it('treats unreadable config as off', () => {
    vi.stubGlobal('useRuntimeConfig', () => {
      throw new Error('no nitro')
    })
    expect(isOverageSellable('cdn.bandwidth_gb')).toBe(false)
  })
})
