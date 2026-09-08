import { describe, expect, it } from 'vitest'
import {
  AI_CREDIT_UNIT_USD,
  estimateMessageCostUsd,
  estimateMessageCredits,
  MAX_CREDITS_PER_MESSAGE,
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

  it('prices by model — the same tokens cost 2.5x more on Opus than Sonnet 5', () => {
    const tokens = { inputTokens: 100_000, outputTokens: 10_000 }
    const sonnet = estimateMessageCostUsd(usage({ ...tokens, model: 'claude-sonnet-5' }))
    const opus = estimateMessageCostUsd(usage({ ...tokens, model: 'claude-opus-4-8' }))
    expect(opus / sonnet).toBeCloseTo(2.5, 5)
  })

  it('knows legacy Conversation-API models and falls back to Sonnet-class price for unknown ids', () => {
    expect(pricingForModel('claude-opus-4-1-20250805')).toEqual({ inputPerMTok: 15, outputPerMTok: 75 })
    expect(pricingForModel('claude-sonnet-4-5')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 })
    expect(pricingForModel('claude-model-from-the-future')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 })
  })
})

describe('estimateMessageCredits', () => {
  it('floors at 1 credit — a light message never costs more than its reservation', () => {
    expect(estimateMessageCredits(usage())).toBe(1)
    expect(estimateMessageCredits(usage({ inputTokens: 2_000, outputTokens: 300, cacheReadInputTokens: 20_000 }))).toBe(1)
  })

  it('weighs a heavy editorial turn by its real cost', () => {
    // Measured Sep 7 shape: ~10K uncached, ~50K cache write, ~180K
    // cache read, 6K output on Sonnet 5 ≈ $0.32 → ~11 credits.
    const credits = estimateMessageCredits(usage({
      inputTokens: 10_000,
      cacheCreationInputTokens: 50_000,
      cacheReadInputTokens: 180_000,
      outputTokens: 6_000,
    }))
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

  it('caps a pathological turn at MAX_CREDITS_PER_MESSAGE', () => {
    const credits = estimateMessageCredits(usage({
      model: 'claude-opus-4-8',
      inputTokens: 2_000_000,
      outputTokens: 500_000,
    }))
    expect(credits).toBe(MAX_CREDITS_PER_MESSAGE)
  })

  it('a Haiku turn costs a fraction of the same Sonnet turn (the starter-tier economics)', () => {
    const shape = { inputTokens: 16_000, cacheCreationInputTokens: 24_000, cacheReadInputTokens: 100_000, outputTokens: 2_000 }
    const haiku = estimateMessageCostUsd(usage({ ...shape, model: 'claude-haiku-4-5-20251001' }))
    const sonnet5 = estimateMessageCostUsd(usage({ ...shape, model: 'claude-sonnet-5' }))
    expect(haiku).toBeLessThan(sonnet5 / 1.9)
  })
})
