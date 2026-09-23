import { describe, expect, it } from 'vitest'
import {
  AI_CREDIT_UNIT_USD,
  DEFAULT_MAX_CREDITS_PER_MESSAGE,
  estimateMessageCostUsd,
  estimateMessageCredits,
  getMaxCreditsPerMessage,
  STARTER_MAX_CREDITS_PER_MESSAGE,
  cacheReadMultiplierFor,
  pricingForModel,
} from '../../shared/utils/ai-credits'

function usage(over: Partial<Parameters<typeof estimateMessageCredits>[0]> = {}) {
  return {
    model: 'claude-sonnet-5',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...over,
  }
}

describe('estimateMessageCostUsd', () => {
  it('bills the four token buckets at input/2x-write/0.1x-read/output rates', () => {
    // Sonnet 5 at $2/$10: 1M input = $2, 1M cache write = $4,
    // 1M cache read = $0.2, 100K output = $1 → $7.20 total.
    const cost = estimateMessageCostUsd(usage({
      inputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      outputTokens: 100_000,
    }))
    expect(cost).toBeCloseTo(7.2, 5)
  })

  it('prices by model — the same uncached tokens cost 2x more on Opus 5.5 than Sonnet 5', () => {
    const tokens = { inputTokens: 100_000, outputTokens: 10_000 }
    const sonnet = estimateMessageCostUsd(usage({ ...tokens, model: 'claude-sonnet-5' }))
    const opus = estimateMessageCostUsd(usage({ ...tokens, model: 'claude-opus-5-5' }))
    expect(opus / sonnet).toBeCloseTo(2, 5)
  })

  it('reads cache at the model\'s own rate — Opus 5.5 at 0.05x, the same $0.20/MTok as Sonnet 5', () => {
    // A flat 0.1x billed Opus 5.5 history at $0.40/MTok, twice Anthropic's price.
    const cached = { cacheReadInputTokens: 1_000_000 }
    expect(estimateMessageCostUsd(usage({ ...cached, model: 'claude-opus-5-5' }))).toBeCloseTo(0.2, 5)
    expect(estimateMessageCostUsd(usage({ ...cached, model: 'claude-sonnet-5' }))).toBeCloseTo(0.2, 5)
    expect(estimateMessageCostUsd(usage({ ...cached, model: 'claude-haiku-4-5-20251001' }))).toBeCloseTo(0.1, 5)
    expect(cacheReadMultiplierFor(pricingForModel('claude-opus-5-5'))).toBe(0.05)
    expect(cacheReadMultiplierFor(pricingForModel('claude-sonnet-4-5'))).toBe(0.1)
  })

  it('settles retired chat models at their own list price', () => {
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
    expect(estimateMessageCredits(usage(), 'pro')).toBe(1)
    expect(estimateMessageCredits(usage({ inputTokens: 2_000, outputTokens: 300, cacheReadInputTokens: 20_000 }), 'pro')).toBe(1)
  })

  it('weighs a heavy editorial turn by its real cost', () => {
    // Measured Sep 7 shape: ~10K uncached, ~50K cache write, ~180K
    // cache read, 6K output on Sonnet 5 ≈ $0.32 → ~11 credits.
    const credits = estimateMessageCredits(usage({
      inputTokens: 10_000,
      cacheCreationInputTokens: 50_000,
      cacheReadInputTokens: 180_000,
      outputTokens: 6_000,
    }), 'pro')
    const cost = estimateMessageCostUsd(usage({
      inputTokens: 10_000,
      cacheCreationInputTokens: 50_000,
      cacheReadInputTokens: 180_000,
      outputTokens: 6_000,
    }))
    expect(credits).toBe(Math.round(cost / AI_CREDIT_UNIT_USD))
    expect(credits).toBeGreaterThanOrEqual(9)
    expect(credits).toBeLessThanOrEqual(12)
  })

  it('caps a pathological turn at the plan ceiling — Pro/Enterprise at 60, Starter at 30', () => {
    const heavy = usage({
      model: 'claude-opus-5-5',
      inputTokens: 2_000_000,
      outputTokens: 500_000,
    })
    expect(estimateMessageCredits(heavy, 'pro')).toBe(DEFAULT_MAX_CREDITS_PER_MESSAGE)
    expect(estimateMessageCredits(heavy, 'enterprise')).toBe(DEFAULT_MAX_CREDITS_PER_MESSAGE)
    expect(estimateMessageCredits(heavy, 'starter')).toBe(STARTER_MAX_CREDITS_PER_MESSAGE)
  })

  it('getMaxCreditsPerMessage: Starter is lower — its quota is small enough that the default 60 cap could burn it in one turn', () => {
    // Starter's quota dropped 90→60 in the same P1 rebase that raised
    // the ceiling 30→60 (SO-14 B-3): a 60-credit turn would be 100% of
    // the Starter quota instead of 12% of Pro's. Starter keeps the old
    // per-message ceiling; Pro/Enterprise take the raised one.
    expect(getMaxCreditsPerMessage('starter')).toBe(30)
    expect(getMaxCreditsPerMessage('pro')).toBe(60)
    expect(getMaxCreditsPerMessage('enterprise')).toBe(60)
    expect(getMaxCreditsPerMessage('community')).toBe(60)
  })

  it('a Haiku turn costs a fraction of the same Sonnet turn (the starter-tier economics)', () => {
    const shape = { inputTokens: 16_000, cacheCreationInputTokens: 24_000, cacheReadInputTokens: 100_000, outputTokens: 2_000 }
    const haiku = estimateMessageCostUsd(usage({ ...shape, model: 'claude-haiku-4-5-20251001' }))
    const sonnet5 = estimateMessageCostUsd(usage({ ...shape, model: 'claude-sonnet-5' }))
    expect(haiku).toBeLessThan(sonnet5 / 1.9)
  })
})
