import { describe, expect, it } from 'vitest'
import {
  CREDIT_METERS,
  CURRENT_CREDIT_UNIT,
  LEGACY_CREDIT_UNIT,
  creditTermsFor,
  creditUnitFromMeters,
} from '../../shared/utils/credit-unit'
import { estimateMessageCostUsd, estimateMessageCredits, getMaxCreditsPerMessage, settleTurnCredits } from '../../shared/utils/ai-credits'

/**
 * Catalog v2 (PRC-3) sells $0.01 credits; the subscriptions sold before it
 * keep $0.03 credits, their quotas, meters and prices. Both kinds of account
 * run side by side, and neither may be billed in the other's unit — a $0.03
 * subscription metered in $0.01 credits would pay 3.2× for the same work.
 */
const legacy = creditTermsFor(LEGACY_CREDIT_UNIT)
const current = creditTermsFor(CURRENT_CREDIT_UNIT)

describe('credit unit per account', () => {
  it('reads the unit off the meters the subscription is priced on', () => {
    expect(creditUnitFromMeters(['ai_credits', 'api_credits', 'mcp_calls', 'form_submissions'])).toBe('0.03')
    // The oldest subscriptions still price the event-counting meters.
    expect(creditUnitFromMeters(['ai_messages', 'api_messages', 'mcp_calls'])).toBe('0.03')
    expect(creditUnitFromMeters(['ai_credits_1c', 'api_credits_1c', 'mcp_calls'])).toBe('0.01')
    // No metered price at all (e.g. an annual product) or nothing recorded: current.
    expect(creditUnitFromMeters([])).toBe('0.01')
    expect(creditUnitFromMeters(null)).toBe('0.01')
  })

  it('keeps each unit on its own meters', () => {
    expect(legacy.meters).toEqual({ ai: 'ai_credits', api: 'api_credits' })
    expect(current.meters).toEqual({ ai: 'ai_credits_1c', api: 'api_credits_1c' })
    expect(CREDIT_METERS['0.03'].ai).not.toBe(CREDIT_METERS['0.01'].ai)
  })

  it('gives a legacy account the quotas and ceilings it was sold, and a v2 account the catalog\'s', () => {
    expect(legacy.creditLimit('starter', 'ai.messages_per_month')).toBe(60)
    expect(legacy.creditLimit('pro', 'ai.messages_per_month')).toBe(350)
    expect(legacy.creditLimit('pro', 'api.messages_per_month')).toBe(140)
    expect(current.creditLimit('starter', 'ai.messages_per_month')).toBe(300)
    expect(current.creditLimit('pro', 'ai.messages_per_month')).toBe(1600)
    expect(current.creditLimit('pro', 'api.messages_per_month')).toBe(450)
    expect(current.creditLimit('starter', 'api.messages_per_month')).toBe(0)
    // Plans the legacy catalog never sold keep the catalog's value.
    expect(legacy.creditLimit('enterprise', 'ai.messages_per_month')).toBe(Infinity)

    expect([getMaxCreditsPerMessage('starter', '0.03'), getMaxCreditsPerMessage('pro', '0.03')]).toEqual([30, 60])
    expect([getMaxCreditsPerMessage('starter', '0.01'), getMaxCreditsPerMessage('pro', '0.01')]).toEqual([75, 150])
  })

  it('prices overage at what each product sells it for', () => {
    expect(legacy.overagePrice('ai.messages_per_month')).toBe(0.08)
    expect(legacy.overagePrice('api.mcp_calls_per_month')).toBe(0.005)
    expect(current.overagePrice('ai.messages_per_month')).toBe(0.025)
    expect(current.overagePrice('api.mcp_calls_per_month')).toBe(0.001)
    // Never below the unit it is counted in.
    expect(legacy.overagePrice('ai.messages_per_month')!).toBeGreaterThan(legacy.unitUsd)
    expect(current.overagePrice('ai.messages_per_month')!).toBeGreaterThan(current.unitUsd)
  })

  it('charges the same work the same dollars in either unit — never 3×', () => {
    // A mid-size Sonnet 5 turn: ~$0.25 of Anthropic spend.
    const usage = { model: 'claude-sonnet-5', inputTokens: 20_000, outputTokens: 12_000, cacheCreationInputTokens: 30_000, cacheReadInputTokens: 150_000 }
    const usd = estimateMessageCostUsd(usage)
    const legacyCredits = settleTurnCredits(usage, 60, '0.03')
    const currentCredits = settleTurnCredits(usage, 150, '0.01')
    // Each unit's credits, at its own unit price, land within one credit of the real cost.
    expect(Math.abs(legacyCredits * 0.03 - usd)).toBeLessThanOrEqual(0.03)
    expect(Math.abs(currentCredits * 0.01 - usd)).toBeLessThanOrEqual(0.01)
    // The v2 settle rounds up (D2): a credit never costs Studio more than it was sold for.
    expect(currentCredits * 0.01).toBeGreaterThanOrEqual(usd)
    // The trap this module exists to close: legacy's credits read as $0.01 would be a third of the cost.
    expect(currentCredits).toBeGreaterThan(legacyCredits * 2.5)
  })

  it('rounds legacy to the nearest credit, as it was sold, and v2 up', () => {
    // $0.07 of spend: legacy 2 credits (2.33 → 2), v2 7 credits (7 → 7, no float drift to 8).
    expect(legacy.toCredits(0.07)).toBe(2)
    expect(current.toCredits(0.07)).toBe(7)
    expect(current.toCredits(0.0701)).toBe(8)
  })

  it('caps a message estimate at the unit\'s own ceiling', () => {
    const heavy = { model: 'claude-opus-5-5', inputTokens: 2_000_000, outputTokens: 500_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    expect(estimateMessageCredits(heavy, 'pro', '0.03')).toBe(60)
    expect(estimateMessageCredits(heavy, 'pro', '0.01')).toBe(150)
  })
})
