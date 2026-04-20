import { describe, expect, it } from 'vitest'
import { getEffectiveLimit, isOverageEnabled, calculateOverageUnits } from '../../server/utils/overage'
import { OVERAGE_PRICING, OVERAGE_SETTINGS_KEYS } from '../../shared/utils/license'

describe('OVERAGE_PRICING constant', () => {
  it('contains every metered category', () => {
    expect(Object.keys(OVERAGE_PRICING)).toEqual([
      'ai.messages_per_month',
      'api.messages_per_month',
      'api.mcp_calls_per_month',
      'cdn.bandwidth_gb',
      'forms.submissions_per_month',
      'media.storage_gb',
    ])
  })

  it('each entry has price > 0, non-empty unit, and non-empty settingsKey', () => {
    for (const [key, val] of Object.entries(OVERAGE_PRICING)) {
      expect(val.price, `${key}.price`).toBeGreaterThan(0)
      expect(val.unit, `${key}.unit`).toBeTruthy()
      expect(val.settingsKey, `${key}.settingsKey`).toBeTruthy()
    }
  })

  it('OVERAGE_SETTINGS_KEYS matches pricing settingsKeys', () => {
    const expected = Object.values(OVERAGE_PRICING).map(p => p.settingsKey)
    expect(OVERAGE_SETTINGS_KEYS).toEqual(expected)
  })
})

describe('getEffectiveLimit', () => {
  it('returns plan limit when overage is disabled (empty settings)', () => {
    expect(getEffectiveLimit(50, 'ai.messages_per_month', {})).toBe(50)
  })

  it('returns plan limit when overage is disabled (null settings)', () => {
    expect(getEffectiveLimit(50, 'ai.messages_per_month', null)).toBe(50)
  })

  it('returns plan limit when overage is disabled (undefined settings)', () => {
    expect(getEffectiveLimit(50, 'ai.messages_per_month', undefined)).toBe(50)
  })

  it('returns plan limit when overage is explicitly false', () => {
    expect(getEffectiveLimit(50, 'ai.messages_per_month', { ai_messages: false })).toBe(50)
  })

  it('returns SOFT_CAP_MAX when overage is enabled', () => {
    expect(getEffectiveLimit(50, 'ai.messages_per_month', { ai_messages: true })).toBe(2_147_483_647)
  })

  it('returns SOFT_CAP_MAX for Infinity limits (enterprise) regardless of overage settings', () => {
    expect(getEffectiveLimit(Infinity, 'ai.messages_per_month', {})).toBe(2_147_483_647)
    expect(getEffectiveLimit(Infinity, 'ai.messages_per_month', { ai_messages: false })).toBe(2_147_483_647)
  })

  it('returns plan limit for unknown limit key', () => {
    expect(getEffectiveLimit(100, 'unknown.key', { ai_messages: true })).toBe(100)
  })

  it('handles each overage category independently', () => {
    const settings = { ai_messages: true, form_submissions: false, cdn_bandwidth: true }

    expect(getEffectiveLimit(50, 'ai.messages_per_month', settings)).toBe(2_147_483_647)
    expect(getEffectiveLimit(100, 'forms.submissions_per_month', settings)).toBe(100)
    expect(getEffectiveLimit(2, 'cdn.bandwidth_gb', settings)).toBe(2_147_483_647)
    expect(getEffectiveLimit(1, 'media.storage_gb', settings)).toBe(1) // not in settings
  })

  it('returns plan limit for zero limits (free plan)', () => {
    expect(getEffectiveLimit(0, 'forms.submissions_per_month', { form_submissions: true })).toBe(2_147_483_647)
    expect(getEffectiveLimit(0, 'forms.submissions_per_month', {})).toBe(0)
  })
})

describe('isOverageEnabled', () => {
  it('returns false when settings is null', () => {
    expect(isOverageEnabled('ai.messages_per_month', null)).toBe(false)
  })

  it('returns false when settings is undefined', () => {
    expect(isOverageEnabled('ai.messages_per_month', undefined)).toBe(false)
  })

  it('returns false when settings is empty', () => {
    expect(isOverageEnabled('ai.messages_per_month', {})).toBe(false)
  })

  it('returns false when category key is explicitly false', () => {
    expect(isOverageEnabled('ai.messages_per_month', { ai_messages: false })).toBe(false)
  })

  it('returns true when category key is true', () => {
    expect(isOverageEnabled('ai.messages_per_month', { ai_messages: true })).toBe(true)
  })

  it('returns false for unknown limit key', () => {
    expect(isOverageEnabled('unknown.key', { ai_messages: true })).toBe(false)
  })

  it('checks correct settings key for each limit', () => {
    expect(isOverageEnabled('ai.messages_per_month', { ai_messages: true })).toBe(true)
    expect(isOverageEnabled('api.messages_per_month', { api_messages: true })).toBe(true)
    expect(isOverageEnabled('cdn.bandwidth_gb', { cdn_bandwidth: true })).toBe(true)
    expect(isOverageEnabled('forms.submissions_per_month', { form_submissions: true })).toBe(true)
    expect(isOverageEnabled('media.storage_gb', { media_storage: true })).toBe(true)
  })
})

describe('calculateOverageUnits', () => {
  it('returns 0 when usage is under limit', () => {
    expect(calculateOverageUnits(30, 50)).toBe(0)
  })

  it('returns 0 when usage equals limit', () => {
    expect(calculateOverageUnits(50, 50)).toBe(0)
  })

  it('returns positive overage when usage exceeds limit', () => {
    expect(calculateOverageUnits(75, 50)).toBe(25)
  })

  it('returns 0 for Infinity limits', () => {
    expect(calculateOverageUnits(999999, Infinity)).toBe(0)
  })

  it('handles zero limit correctly', () => {
    expect(calculateOverageUnits(5, 0)).toBe(5)
  })

  it('handles fractional values (GB storage)', () => {
    expect(calculateOverageUnits(1.5, 1.0)).toBeCloseTo(0.5)
  })
})
