import { describe, expect, it } from 'vitest'
import { getEffectiveLimit, isOverageEnabled, isOverageSellable } from '../../server/utils/overage'
import { USAGE_METERS } from '../../shared/utils/usage-meters'

/**
 * Two meters cannot carry an included allowance: Polar caps a meter
 * credit at int32, and a gigabyte counted in bytes exceeds it. Selling
 * overage against an allowance that cannot be expressed would bill from
 * the first byte — the plan's included gigabytes among them. So those
 * limits are hard, and no stored toggle may raise them.
 */
describe('limits that are not sold past the plan allowance', () => {
  const SOFT_CAP_MAX = 2_147_483_647
  const bothOn = { cdn_bandwidth: true, media_storage: true, ai_messages: true }

  it('marks exactly the byte meters unsellable', () => {
    expect(isOverageSellable('cdn.bandwidth_gb')).toBe(false)
    expect(isOverageSellable('media.storage_gb')).toBe(false)

    expect(isOverageSellable('ai.messages_per_month')).toBe(true)
    expect(isOverageSellable('api.messages_per_month')).toBe(true)
    expect(isOverageSellable('api.mcp_calls_per_month')).toBe(true)
    expect(isOverageSellable('forms.submissions_per_month')).toBe(true)
  })

  it('derives that from the meter manifest, not a second list', () => {
    expect(USAGE_METERS.CDN_BANDWIDTH_BYTES.overageBillable).toBe(false)
    expect(USAGE_METERS.MEDIA_STORAGE_BYTE_HOURS.overageBillable).toBe(false)
    expect(USAGE_METERS.AI_MESSAGES.overageBillable).toBe(true)
  })

  it('keeps the cap hard even when the workspace has the toggle on', () => {
    // A stale `true` in `overage_settings` — from before the limit became
    // hard, or set by an older client — must not raise the cap.
    expect(getEffectiveLimit(60, 'cdn.bandwidth_gb', bothOn)).toBe(60)
    expect(getEffectiveLimit(15, 'media.storage_gb', bothOn)).toBe(15)
    expect(isOverageEnabled('cdn.bandwidth_gb', bothOn)).toBe(false)
    expect(isOverageEnabled('media.storage_gb', bothOn)).toBe(false)
  })

  it('still raises the cap for the limits that are sold', () => {
    expect(getEffectiveLimit(350, 'ai.messages_per_month', bothOn)).toBe(SOFT_CAP_MAX)
    expect(isOverageEnabled('ai.messages_per_month', bothOn)).toBe(true)
    // And still stops at the plan limit when the toggle is off.
    expect(getEffectiveLimit(350, 'ai.messages_per_month', {})).toBe(350)
  })

  it('leaves an unlimited plan unlimited', () => {
    // Enterprise: the soft cap keeps the RPC integer-typed; a hard limit
    // must not turn that into Infinity or back into a real ceiling.
    expect(getEffectiveLimit(Infinity, 'cdn.bandwidth_gb', {})).toBe(SOFT_CAP_MAX)
  })
})
