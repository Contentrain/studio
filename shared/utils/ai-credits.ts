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
 * Flow, studio chat (`chat.post.ts`, since AI-8): the atomic
 * reservation takes the whole turn ceiling up front — up to
 * `getMaxCreditsPerMessage(plan)`, never more than the credits left in
 * the pool (`reserve_agent_credits`, migration 031) — and the engine
 * spends against that reservation as a dollar budget
 * (`server/utils/turn-budget.ts`). The settle runs in `finally`, from
 * the real token totals, and refunds what the turn did not use. So two
 * concurrent turns cannot overshoot the pool, and a cancelled or failed
 * turn counts what it really cost (`settleTurnCredits`).
 *
 * The Conversation API (`ee/enterprise/conversation-api.ts`) still uses
 * the older flow — reserve 1, settle `credits - 1` — and can overshoot
 * by at most `getMaxCreditsPerMessage(plan) - 1`.
 *
 * BYOA messages stay at 1 credit — the token cost is on the user's
 * own Anthropic key, so Studio only meters the platform usage.
 */
import type { StudioPlan } from './license'
import { CURRENT_CREDIT_UNIT, creditTermsFor } from './credit-unit'
import type { CreditUnit } from './credit-unit'
import type { ModelPricing } from './ai-models'
import { CHAT_MODELS } from './ai-models'

/**
 * One credit of the current catalog (v2): $0.01 of Anthropic spend. An
 * account's own unit — $0.03 for subscriptions sold before v2 — comes from
 * `creditTermsFor(unit)` (`credit-unit.ts`); every function below takes it.
 * Overage is never sold below the unit it is counted in.
 */
export const AI_CREDIT_UNIT_USD = creditTermsFor(CURRENT_CREDIT_UNIT).unitUsd

/**
 * Per-message ceiling, plan- and unit-dependent. Bounds both the quota
 * overshoot of a turn and the bill for a pathological one: the turn
 * reserves this up front (`reserve_agent_credits`) and the turn budget
 * keeps the spend inside it (`turn-budget.ts`).
 *
 * Current unit ($0.01): Starter 75, others 150 — $0.75 / $1.50 per turn
 * (PRC-2 §3). Legacy unit ($0.03): Starter 30, others 60, as sold.
 */
export function getMaxCreditsPerMessage(plan: StudioPlan | string, unit: CreditUnit): number {
  return creditTermsFor(unit).maxCreditsPerMessage(plan)
}

/** Cache-write premium — Studio caches on the 1h TTL (`PROMPT_CACHE_CONTROL`). */
export const CACHE_WRITE_MULTIPLIER = 2
/** Cache-read discount. */
export const CACHE_READ_MULTIPLIER = 0.1

/**
 * Models no longer offered in the chat catalog: Conversation-API
 * models and retired chat models. A retired model keeps its entry so
 * a turn that started on it, and any later re-computation, settles at
 * what Anthropic actually billed.
 */
const LEGACY_MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-1-20250805': { inputPerMTok: 15, outputPerMTok: 75 },
}

const CATALOG_PRICING: Record<string, ModelPricing>
  = Object.fromEntries(CHAT_MODELS.map(m => [m.id, m.pricing]))

/**
 * An ID in neither table (a new model reaching a call site before the
 * catalog learns its price) is priced as the dearest model Studio
 * offers. Erring high keeps the turn budget and the settle from
 * under-counting a premium model; the catalog entry replaces the guess.
 */
const FALLBACK_PRICING: ModelPricing = CHAT_MODELS
  .map(m => m.pricing)
  .reduce((dearest, p) => (p.outputPerMTok > dearest.outputPerMTok ? p : dearest))

export function pricingForModel(modelId: string): ModelPricing {
  return CATALOG_PRICING[modelId] ?? LEGACY_MODEL_PRICING[modelId] ?? FALLBACK_PRICING
}

/** Cache-read rate for a model, as a fraction of its input price (0.1x standard, 0.05x on Opus 5.5). */
export function cacheReadMultiplierFor(pricing: ModelPricing): number {
  return pricing.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER
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
    + usage.cacheReadInputTokens * pricing.inputPerMTok * cacheReadMultiplierFor(pricing)
    + usage.outputTokens * pricing.outputPerMTok
  ) / 1e6
}

/**
 * Credits a message consumes against the monthly quota, in the account's
 * unit. Always ≥ 1 (the reservation), capped at the plan's per-message
 * ceiling (`getMaxCreditsPerMessage`).
 */
export function estimateMessageCredits(usage: MessageUsage, plan: StudioPlan | string, unit: CreditUnit): number {
  const terms = creditTermsFor(unit)
  const credits = terms.toCredits(estimateMessageCostUsd(usage))
  return Math.min(terms.maxCreditsPerMessage(plan), Math.max(1, credits))
}

/**
 * Credits a turn settles at, from its real token totals, in the account's
 * unit. Unlike `estimateMessageCredits` this is not rounded up to 1: a turn
 * that never reached the model (no tokens) costs 0 and is fully refunded,
 * while any turn with tokens costs at least 1. It is bounded by the credits
 * reserved for it — the turn budget kept the spend inside that reservation,
 * and anything a single call ran over is Studio's. The current unit rounds
 * up (D2), the legacy unit to the nearest credit, as each was sold.
 */
export function settleTurnCredits(usage: MessageUsage, reserved: number, unit: CreditUnit): number {
  const tokens = usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
  if (tokens === 0) return 0
  const credits = Math.max(1, creditTermsFor(unit).toCredits(estimateMessageCostUsd(usage)))
  return Math.min(Math.max(1, reserved), credits)
}
