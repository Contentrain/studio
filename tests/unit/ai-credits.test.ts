import { describe, expect, it } from 'vitest'
import {
  AI_CREDIT_UNIT_USD,
  estimateMessageCostUsd,
  estimateMessageCredits,
  getMaxCreditsPerMessage,
  cacheReadMultiplierFor,
  pricingForModel,
} from '../../shared/utils/ai-credits'

function usage(over: Partial<Parameters<typeof estimateMessageCredits>[0]> = {}) {
  return {
    model: 'claude-sonnet-5-5',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...over,
  }
}

describe('estimateMessageCostUsd', () => {
  it('bills the four token buckets at input/2x-write/0.1x-read/output rates', () => {
    // Sonnet 5 (retired, standard 0.1x read) at $2/$10: 1M input = $2,
    // 1M cache write = $4, 1M cache read = $0.2, 100K output = $1 → $7.20.
    const cost = estimateMessageCostUsd(usage({
      model: 'claude-sonnet-5',
      inputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      outputTokens: 100_000,
    }))
    expect(cost).toBeCloseTo(7.2, 5)
  })

  it('prices by model — the same uncached tokens cost 2x more on Opus 5.5 than Sonnet 5.5', () => {
    const tokens = { inputTokens: 100_000, outputTokens: 10_000 }
    const sonnet = estimateMessageCostUsd(usage({ ...tokens, model: 'claude-sonnet-5-5' }))
    const opus = estimateMessageCostUsd(usage({ ...tokens, model: 'claude-opus-5-5' }))
    expect(opus / sonnet).toBeCloseTo(2, 5)
  })

  it('reads cache at the model\'s own rate — 0.05x on Opus 5.5 and Sonnet 5.5, 0.1x elsewhere', () => {
    // A flat 0.1x billed Opus 5.5 history at $0.40/MTok, twice Anthropic's price.
    // Sonnet 5.5 reads at $0.10/MTok (pricing page, footnote 2), Sonnet 5 at $0.20.
    const cached = { cacheReadInputTokens: 1_000_000 }
    expect(estimateMessageCostUsd(usage({ ...cached, model: 'claude-opus-5-5' }))).toBeCloseTo(0.2, 5)
    expect(estimateMessageCostUsd(usage({ ...cached, model: 'claude-sonnet-5-5' }))).toBeCloseTo(0.1, 5)
    expect(estimateMessageCostUsd(usage({ ...cached, model: 'claude-sonnet-5' }))).toBeCloseTo(0.2, 5)
    expect(estimateMessageCostUsd(usage({ ...cached, model: 'claude-haiku-4-5-20251001' }))).toBeCloseTo(0.1, 5)
    // Haiku 5.5: 1M of cache read is a 1M-token prompt — the long card's $0.05/MTok.
    expect(estimateMessageCostUsd(usage({ ...cached, model: 'claude-haiku-5-5' }))).toBeCloseTo(0.05, 5)
    expect(cacheReadMultiplierFor(pricingForModel('claude-opus-5-5'))).toBe(0.05)
    expect(cacheReadMultiplierFor(pricingForModel('claude-sonnet-5-5'))).toBe(0.05)
    expect(cacheReadMultiplierFor(pricingForModel('claude-sonnet-4-5'))).toBe(0.1)
  })

  it('settles retired chat models at their own list price', () => {
    expect(pricingForModel('claude-sonnet-5')).toEqual({ inputPerMTok: 2, outputPerMTok: 10 })
    expect(pricingForModel('claude-haiku-4-5-20251001')).toEqual({ inputPerMTok: 1, outputPerMTok: 5 })
    expect(pricingForModel('claude-sonnet-4-6')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 })
    expect(pricingForModel('claude-opus-4-8')).toEqual({ inputPerMTok: 5, outputPerMTok: 25 })
  })

  it('knows legacy Conversation-API models and prices an unknown id as the dearest catalog model', () => {
    expect(pricingForModel('claude-opus-4-1-20250805')).toEqual({ inputPerMTok: 15, outputPerMTok: 75 })
    expect(pricingForModel('claude-sonnet-4-5')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 })
    // Erring high: a premium model reaching a call site before its
    // catalog entry must not be under-counted by the budget or settle.
    expect(pricingForModel('claude-model-from-the-future')).toEqual({ inputPerMTok: 4, outputPerMTok: 20, cacheReadMultiplier: 0.05 })
  })
})

describe('estimateMessageCredits', () => {
  it('floors at 1 credit — a light message never costs more than its reservation', () => {
    // Legacy $0.03 credits: a light message rounds to the 1-credit floor.
    expect(estimateMessageCredits(usage(), 'pro', '0.03')).toBe(1)
    expect(estimateMessageCredits(usage({ inputTokens: 3_000, outputTokens: 300, cacheReadInputTokens: 20_000 }), 'pro', '0.03')).toBe(1)
    // $0.01 credits round up: the same ~$0.011 message (Sonnet 5.5) is 2 credits, never less than its cost.
    expect(estimateMessageCredits(usage(), 'pro', '0.01')).toBe(1)
    expect(estimateMessageCredits(usage({ inputTokens: 3_000, outputTokens: 300, cacheReadInputTokens: 20_000 }), 'pro', '0.01')).toBe(2)
  })

  it('weighs a heavy editorial turn by its real cost', () => {
    // Measured Sep 7 shape: ~10K uncached, ~50K cache write, ~180K
    // cache read, 6K output on Sonnet 5.5 ≈ $0.30 → ~10 credits.
    const credits = estimateMessageCredits(usage({
      inputTokens: 10_000,
      cacheCreationInputTokens: 50_000,
      cacheReadInputTokens: 180_000,
      outputTokens: 6_000,
    }), 'pro', '0.03')
    const cost = estimateMessageCostUsd(usage({
      inputTokens: 10_000,
      cacheCreationInputTokens: 50_000,
      cacheReadInputTokens: 180_000,
      outputTokens: 6_000,
    }))
    // Legacy unit ($0.03, nearest).
    expect(credits).toBe(Math.round(cost / 0.03))
    expect(credits).toBeGreaterThanOrEqual(9)
    expect(credits).toBeLessThanOrEqual(12)
    // Current unit ($0.01, up): about three times as many credits for the same dollars.
    const current = estimateMessageCredits(usage({ inputTokens: 10_000, cacheCreationInputTokens: 50_000, cacheReadInputTokens: 180_000, outputTokens: 6_000 }), 'pro', '0.01')
    expect(current).toBe(Math.ceil(cost / AI_CREDIT_UNIT_USD - 1e-9))
    expect(AI_CREDIT_UNIT_USD).toBe(0.01)
  })

  it('caps a pathological turn at the plan ceiling of its unit', () => {
    const heavy = usage({
      model: 'claude-opus-5-5',
      inputTokens: 2_000_000,
      outputTokens: 500_000,
    })
    // Legacy: Pro/Enterprise 60, Starter 30 ($1.80 / $0.90).
    expect(estimateMessageCredits(heavy, 'pro', '0.03')).toBe(60)
    expect(estimateMessageCredits(heavy, 'enterprise', '0.03')).toBe(60)
    expect(estimateMessageCredits(heavy, 'starter', '0.03')).toBe(30)
    // Current: Pro/Enterprise 150, Starter 75 ($1.50 / $0.75).
    expect(estimateMessageCredits(heavy, 'pro', '0.01')).toBe(150)
    expect(estimateMessageCredits(heavy, 'starter', '0.01')).toBe(75)
  })

  it('getMaxCreditsPerMessage: Starter is lower — its quota is small enough that the default 60 cap could burn it in one turn', () => {
    // Starter's quota dropped 90→60 in the same P1 rebase that raised
    // the ceiling 30→60 (SO-14 B-3): a 60-credit turn would be 100% of
    // the Starter quota instead of 12% of Pro's. Starter keeps the old
    // per-message ceiling; Pro/Enterprise take the raised one.
    expect(getMaxCreditsPerMessage('starter', '0.03')).toBe(30)
    expect(getMaxCreditsPerMessage('pro', '0.03')).toBe(60)
    expect(getMaxCreditsPerMessage('enterprise', '0.03')).toBe(60)
    expect(getMaxCreditsPerMessage('community', '0.03')).toBe(60)
    expect(getMaxCreditsPerMessage('starter', '0.01')).toBe(75)
    expect(getMaxCreditsPerMessage('community', '0.01')).toBe(150)
  })

  it('a Haiku turn costs a fraction of the same Sonnet turn (the starter-tier economics)', () => {
    const shape = { inputTokens: 16_000, cacheCreationInputTokens: 24_000, cacheReadInputTokens: 100_000, outputTokens: 2_000 }
    const haiku = estimateMessageCostUsd(usage({ ...shape, model: 'claude-haiku-5-5' }))
    const sonnet = estimateMessageCostUsd(usage({ ...shape, model: 'claude-sonnet-5-5' }))
    expect(haiku).toBeLessThan(sonnet / 1.9)
  })
})

describe('Haiku 5.5 long-prompt card', () => {
  const HAIKU = 'claude-haiku-5-5'

  it('prices a prompt up to 100K on the base card, cache multipliers on top', () => {
    // 20K input $0.002 + 30K 1h write (2x) $0.006 + 50K read (0.1x) $0.0005 + 4K output $0.002.
    const cost = estimateMessageCostUsd(usage({ model: HAIKU, inputTokens: 20_000, cacheCreationInputTokens: 30_000, cacheReadInputTokens: 50_000, outputTokens: 4_000 }))
    expect(cost).toBeCloseTo(0.0105, 6)
  })

  it('prices a request over 100K on the long card — every token, output included', () => {
    // Prompt 100,001 tokens (reads count): 5x the base card on all of it.
    const shape = { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 100_000, outputTokens: 1_000 }
    const cost = estimateMessageCostUsd(usage({ model: HAIKU, ...shape }))
    expect(cost).toBeCloseTo((1 * 0.5 + 100_000 * 0.05 + 1_000 * 2.5) / 1e6, 9)
    expect(pricingForModel(HAIKU).longPrompt).toEqual({ overTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 })
  })

  it('prices each request on its own card when the split is known', () => {
    // Two calls: 60K prompt (base) and 120K prompt (long). Summed totals alone
    // (180K) would put both on the long card.
    const shortCall = { inputTokens: 10_000, cacheCreationInputTokens: 50_000, cacheReadInputTokens: 0, outputTokens: 2_000 }
    const longCall = { inputTokens: 10_000, cacheCreationInputTokens: 10_000, cacheReadInputTokens: 100_000, outputTokens: 2_000 }
    const totals = {
      inputTokens: 20_000,
      cacheCreationInputTokens: 60_000,
      cacheReadInputTokens: 100_000,
      outputTokens: 4_000,
    }
    const split = estimateMessageCostUsd(usage({ model: HAIKU, ...totals, longPrompt: longCall }))
    const separately = estimateMessageCostUsd(usage({ model: HAIKU, ...shortCall })) + estimateMessageCostUsd(usage({ model: HAIKU, ...longCall }))
    expect(split).toBeCloseTo(separately, 9)
    // Without the split the totals are one 180K prompt: above the real cost, never below.
    const unsplit = estimateMessageCostUsd(usage({ model: HAIKU, ...totals }))
    expect(unsplit).toBeGreaterThan(split)
  })

  it('never settles below the credit unit: a tiny Haiku turn is still 1 credit', () => {
    expect(estimateMessageCredits(usage({ model: HAIKU, inputTokens: 100, outputTokens: 10 }), 'starter', '0.01')).toBe(1)
  })
})
