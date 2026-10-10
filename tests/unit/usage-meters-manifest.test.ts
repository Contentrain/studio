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
    expect(USAGE_METERS.MEDIA_STORAGE_GB_MONTHS.aggregation).toBe('sum')
    // These two always carry value 1, so counting and summing agree.
    expect(USAGE_METERS.MCP_CALLS.aggregation).toBe('count')
    expect(USAGE_METERS.FORM_SUBMISSIONS.aggregation).toBe('count')
  })

  it('carries the corrected credit meter names', () => {
    // The old `ai_messages` / `api_messages` meters count events and
    // cannot be re-aggregated under recorded history.
    // Catalog v2 sells $0.01 credits on meters of their own; the $0.03
    // meters stay in Polar for pre-v2 subscriptions (credit-unit.ts).
    expect(USAGE_METERS.AI_MESSAGES.name).toBe('ai_credits_1c')
    expect(USAGE_METERS.API_MESSAGES.name).toBe('api_credits_1c')
  })

  it('meters storage in the unit the plan sells: GB-months', () => {
    // The byte-hour meter could not carry a gigabyte allowance (int32 meter
    // credit) and never received an event; the GB-month meter's allowance
    // is the plan value as is.
    expect(USAGE_METERS.MEDIA_STORAGE_GB_MONTHS.name).toBe('media_storage_gb_months')
    expect(USAGE_METERS.MEDIA_STORAGE_GB_MONTHS.unitsPerLimitUnit).toBe(1)
    expect(USAGE_METER_LIST.some(m => m.name === 'media_storage_byte_hours')).toBe(false)
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

  it('keeps every billable meter at parity with its limit', () => {
    // A billable meter's allowance is the plan value; a meter counting a
    // smaller unit cannot carry it (int32 meter credit) and would bill from
    // the first unit.
    for (const meter of USAGE_METER_LIST) {
      if (meter.overageBillable) expect(meter.unitsPerLimitUnit).toBe(1)
    }
  })

  it('sells CDN and storage overage, priced per plan unit', () => {
    // What the sync writes as Polar's `unit_amount` (cents per meter unit).
    expect(USAGE_METERS.CDN_ORIGIN_GB.overageBillable).toBe(true)
    expect(USAGE_METERS.MEDIA_STORAGE_GB_MONTHS.overageBillable).toBe(true)
    expect(OVERAGE_PRICING['cdn.bandwidth_gb']!.price * 100 / USAGE_METERS.CDN_ORIGIN_GB.unitsPerLimitUnit).toBe(15)
    expect(OVERAGE_PRICING['media.storage_gb']!.price * 100 / USAGE_METERS.MEDIA_STORAGE_GB_MONTHS.unitsPerLimitUnit).toBe(25)
  })

  it('keeps every settings key distinct; a billable meter has a priced limit, a hard limit none', () => {
    const keys = USAGE_METER_LIST.map(m => m.settingsKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const meter of USAGE_METER_LIST) {
      if (meter.overageBillable)
        expect(OVERAGE_PRICING[meter.limitKey]?.settingsKey).toBe(meter.settingsKey)
      else
        expect(OVERAGE_PRICING[meter.limitKey]).toBeUndefined()
    }
  })
})
