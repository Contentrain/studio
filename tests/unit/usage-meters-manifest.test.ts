import { describe, expect, it } from 'vitest'
import { USAGE_METER_LIST, USAGE_METERS } from '../../shared/utils/usage-meters'
import { OVERAGE_PRICING, getPlanLimitForPlan } from '../../shared/utils/license'

/**
 * The manifest is what the Polar sync writes into the billing catalogue:
 * meter aggregation, included allowance, and unit price all derive from
 * it. Both fields it gained here were discovered as live defects, so they
 * are pinned rather than trusted.
 */
describe('usage meter manifest', () => {
  it('sums the meters whose events carry a quantity', () => {
    // Counting bills one per ingest call. A credit-weighted turn emits a
    // base event plus a top-up event carrying N extra credits, so counting
    // would bill 2 where the ledger says N+1.
    expect(USAGE_METERS.AI_MESSAGES.aggregation).toBe('sum')
    expect(USAGE_METERS.API_MESSAGES.aggregation).toBe('sum')
    expect(USAGE_METERS.CDN_ORIGIN_GB.aggregation).toBe('sum')
    expect(USAGE_METERS.MEDIA_STORAGE_BYTE_HOURS.aggregation).toBe('sum')
    // These two always carry value 1, so counting and summing agree.
    expect(USAGE_METERS.MCP_CALLS.aggregation).toBe('count')
    expect(USAGE_METERS.FORM_SUBMISSIONS.aggregation).toBe('count')
  })

  it('carries the corrected credit meter names', () => {
    // The old `ai_messages` / `api_messages` meters count events and
    // cannot be re-aggregated under recorded history.
    expect(USAGE_METERS.AI_MESSAGES.name).toBe('ai_credits')
    expect(USAGE_METERS.API_MESSAGES.name).toBe('api_credits')
  })

  it('converts a gigabyte limit into the byte unit the storage meter sums', () => {
    // The plan limit is in GB; the meter sums raw bytes. Sending the limit
    // straight through would include two *bytes* on a 2 GB plan.
    expect(USAGE_METERS.MEDIA_STORAGE_BYTE_HOURS.unitsPerLimitUnit).toBe(1024 ** 3)
  })

  it('meters CDN origin transfer in the unit the plan sells: gigabytes', () => {
    // The byte meter could not carry a gigabyte allowance (int32 meter
    // credit); the GB meter's allowance is the plan value as is.
    expect(USAGE_METERS.CDN_ORIGIN_GB.name).toBe('cdn_origin_gb')
    expect(USAGE_METERS.CDN_ORIGIN_GB.unitsPerLimitUnit).toBe(1)
    expect(USAGE_METER_LIST.some(m => m.name === 'cdn_bandwidth_bytes')).toBe(false)
    const starterGb = getPlanLimitForPlan('starter', 'cdn.bandwidth_gb')
    expect(starterGb * USAGE_METERS.CDN_ORIGIN_GB.unitsPerLimitUnit).toBe(starterGb)
  })

  it('keeps every other meter at parity with its limit', () => {
    for (const meter of USAGE_METER_LIST) {
      if (meter.unitLabel === 'byte' || meter.unitLabel === 'byte·hour') continue
      expect(meter.unitsPerLimitUnit).toBe(1)
    }
  })

  it('prices a per-gigabyte overage per gigabyte, exactly', () => {
    // What the sync writes as Polar's `unit_amount` (cents per meter unit).
    const perGb = OVERAGE_PRICING['cdn.bandwidth_gb']!.price
    expect(perGb * 100 / USAGE_METERS.CDN_ORIGIN_GB.unitsPerLimitUnit).toBe(perGb * 100)
  })

  it('keeps every settings key distinct and matched to a priced limit', () => {
    const keys = USAGE_METER_LIST.map(m => m.settingsKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const meter of USAGE_METER_LIST) {
      expect(OVERAGE_PRICING[meter.limitKey]?.settingsKey).toBe(meter.settingsKey)
    }
  })
})
