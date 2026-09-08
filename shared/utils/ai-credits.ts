/**
 * Credit weighting for AI messages.
 *
 * Studio sells a per-message quota but buys tokens: a short question
 * costs ~$0.01 of Anthropic spend while a six-iteration editorial turn
 * costs $0.40+ — an 80x spread inside one "message". Counting every
 * turn as 1 unit made heavy turns loss-making at any sane price
 * (measured Sep 2026: avg $0.18/message on a real editorial workspace
 * against a $0.03 implied per-message price).
 *
 * The fix: quota and overage count **credits**. A light message is 1
 * credit; a heavy one consumes credits proportional to what it
 * actually cost, derived from the same four token buckets Anthropic
 * bills (uncached input, cache write at the 1h-TTL 2x rate, cache
 * read at 0.1x, output).
 *
 * Flow (see `chat.post.ts` / `ee/enterprise/conversation-api.ts`):
 * the atomic reservation still takes 1 credit up front (the quota
 * gate), and the turn-end settle adds `credits - 1` via the `_v3`
 * usage RPCs + a top-up meter event. A message can therefore overshoot
 * the monthly cap by at most `MAX_CREDITS_PER_MESSAGE - 1` — bounded
 * and deliberate (the spend already happened; blocking retroactively
 * is impossible).
 *
 * BYOA messages stay at 1 credit — the token cost is on the user's
 * own Anthropic key, so Studio only meters the platform usage.
 */
import type { ModelPricing } from './ai-models'
import { CHAT_MODELS } from './ai-models'

/**
 * One credit ≈ this much Anthropic spend. Chosen so a typical light
 * message (short question, warm cache) rounds to 1 credit and plan
 * quotas keep their advertised magnitude (starter 150, pro 1500).
 */
export const AI_CREDIT_UNIT_USD = 0.03

/**
 * Per-message ceiling. Bounds both the quota overshoot of the
 * reserve-then-settle flow and the bill for a pathological turn.
 */
export const MAX_CREDITS_PER_MESSAGE = 30

/** Cache-write premium — Studio caches on the 1h TTL (`PROMPT_CACHE_CONTROL`). */
const CACHE_WRITE_MULTIPLIER = 2
/** Cache-read discount. */
const CACHE_READ_MULTIPLIER = 0.1

/**
 * Conversation-API / legacy models not in the chat catalog. Unknown
 * models fall back to Sonnet-class list price — wrong for a future
 * cheap model (over-counts, fails safe) and for a future premium one
 * (under-counts until the catalog learns it).
 */
const LEGACY_MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-1-20250805': { inputPerMTok: 15, outputPerMTok: 75 },
}

const FALLBACK_PRICING: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15 }

const CATALOG_PRICING: Record<string, ModelPricing>
  = Object.fromEntries(CHAT_MODELS.map(m => [m.id, m.pricing]))

export function pricingForModel(modelId: string): ModelPricing {
  return CATALOG_PRICING[modelId] ?? LEGACY_MODEL_PRICING[modelId] ?? FALLBACK_PRICING
}

export interface MessageUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

/** Approximate Anthropic spend for one message's turn totals. */
export function estimateMessageCostUsd(usage: MessageUsage): number {
  const pricing = pricingForModel(usage.model)
  return (
    usage.inputTokens * pricing.inputPerMTok
    + usage.cacheCreationInputTokens * pricing.inputPerMTok * CACHE_WRITE_MULTIPLIER
    + usage.cacheReadInputTokens * pricing.inputPerMTok * CACHE_READ_MULTIPLIER
    + usage.outputTokens * pricing.outputPerMTok
  ) / 1e6
}

/**
 * Credits a message consumes against the monthly quota. Always ≥ 1
 * (the reservation), capped at `MAX_CREDITS_PER_MESSAGE`.
 */
export function estimateMessageCredits(usage: MessageUsage): number {
  const credits = Math.round(estimateMessageCostUsd(usage) / AI_CREDIT_UNIT_USD)
  return Math.min(MAX_CREDITS_PER_MESSAGE, Math.max(1, credits))
}
