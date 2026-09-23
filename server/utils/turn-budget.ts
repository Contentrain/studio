/**
 * Per-turn spend budget for the conversation loop (AI-8).
 *
 * A turn used to be bounded only by its iteration count: 8 tool
 * iterations + a wrap call, each allowed 16K output tokens. The credit
 * cap (`getMaxCreditsPerMessage`) bounded what the customer was
 * *charged*, not what Studio *spent* — an Opus turn could cost $6–12
 * against a $1.80 cap, and the difference was Studio's loss.
 *
 * The budget closes that gap from inside the loop. Before every model
 * call the engine asks `planCall` whether the remaining budget covers
 * the call's worst case (its prompt, estimated conservatively, plus the
 * full output allowance). If it does not, `max_tokens` is lowered to
 * what the budget can pay for; if even a useful minimum does not fit,
 * the loop stops calling tools and closes the turn with a short
 * summary (or, when not even that fits, a deterministic message).
 *
 * The budget is the credits reserved for the turn (min(plan ceiling,
 * credits left in the pool)) × `AI_CREDIT_UNIT_USD`. A normal turn —
 * a few iterations, a few thousand output tokens — spends a fraction
 * of it and never notices; only an excessive or abusive turn is cut.
 */
import type { AIUsage } from '../providers/ai'
import type { ModelPricing } from '../../shared/utils/ai-models'
import {
  CACHE_WRITE_MULTIPLIER,
  cacheReadMultiplierFor,
  estimateMessageCostUsd,
  pricingForModel,
} from '../../shared/utils/ai-credits'
import { thinkingModeFor } from '../../shared/utils/ai-models'

/** Below this output allowance a tool-using iteration is not worth making. */
export const MIN_TOOL_CALL_OUTPUT_TOKENS = 1024
/** Output allowance for the budget-close summary call. */
export const CLOSE_OUTPUT_TOKENS = 1024
/** Below this, even the summary call is skipped for a deterministic message. */
export const MIN_CLOSE_OUTPUT_TOKENS = 256
/**
 * Room kept for one call's tool results when reserving for the close
 * (`closeReserveUsd`): the engine's tool-result cap (32,000 chars) at
 * the history budget's ~3.5 chars/token.
 */
export const CLOSE_TOOL_RESULT_ALLOWANCE_TOKENS = 9200

/**
 * Output a thinking model (`thinking: 'adaptive'`, Opus 5.5) spends on its
 * reasoning before it writes anything — counted against `max_tokens` like
 * the answer. A call whose ceiling the budget lowered to the plain floors
 * above could spend all of it thinking and stop with nothing to show
 * (`output_truncated`): the customer pays for the credits and gets no
 * answer. So on those models every floor carries this headroom on top.
 * Effort is not lowered instead: changing it mid-conversation invalidates
 * the prompt cache, which would cost more than it saves.
 */
export const THINKING_HEADROOM_TOKENS = 3072

export interface OutputFloors {
  /** Below this output allowance a tool-using iteration is not made. */
  minToolCall: number
  /** Output allowance for the budget-close summary call. */
  close: number
  /** Below this, the summary call is skipped for a deterministic message. */
  minClose: number
}

/** The output floors for a model: the plain ones, plus thinking headroom on thinking models. */
export function outputFloorsFor(model: string): OutputFloors {
  const headroom = thinkingModeFor(model) === 'adaptive' ? THINKING_HEADROOM_TOKENS : 0
  return {
    minToolCall: MIN_TOOL_CALL_OUTPUT_TOKENS + headroom,
    close: CLOSE_OUTPUT_TOKENS + headroom,
    minClose: MIN_CLOSE_OUTPUT_TOKENS + headroom,
  }
}

export interface TurnBudget {
  /** Dollars the turn may spend at list price. */
  maxUsd: number
  /**
   * What sets the ceiling. `turn`: the plan's per-message cap — the next
   * message starts with a full budget. `credits`: the workspace's monthly
   * credits ran short of that cap — the next message will be refused, so
   * the close must not tell the user to "send a new message".
   */
  limitedBy?: 'turn' | 'credits'
}

/**
 * The prompt of the next call, split by how it will be billed at worst.
 * `cached` was already in the previous call's prompt (a cache hit on
 * the second read); `fresh` is new since then — the previous call's
 * uncached input, its output and the tool results — and is priced as a
 * cache write, the most expensive way it can be billed.
 */
export interface PromptEstimate {
  cached: number
  fresh: number
}

export function promptCostUsd(prompt: PromptEstimate, pricing: ModelPricing): number {
  return (
    prompt.fresh * pricing.inputPerMTok * CACHE_WRITE_MULTIPLIER
    + prompt.cached * pricing.inputPerMTok * cacheReadMultiplierFor(pricing)
  ) / 1e6
}

export type CallPlan
  = | { ok: true, maxTokens: number, limited: boolean }
    | { ok: false }

/**
 * Can the next call be made within the budget, and with how much
 * output? `limited` says the budget, not the configured ceiling, set
 * `maxTokens` — a `max_tokens` stop on such a call is a budget stop.
 */
export function planCall(input: {
  budget: TurnBudget
  spentUsd: number
  model: string
  prompt: PromptEstimate
  maxOutputTokens: number
  minOutputTokens: number
  /** Kept back for a later call — the close summary (`closeReserveUsd`). */
  reserveUsd?: number
}): CallPlan {
  const pricing = pricingForModel(input.model)
  const remaining = input.budget.maxUsd - input.spentUsd - (input.reserveUsd ?? 0) - promptCostUsd(input.prompt, pricing)
  const affordable = Math.floor(remaining / (pricing.outputPerMTok / 1e6))
  if (affordable < input.minOutputTokens) return { ok: false }
  const maxTokens = Math.min(input.maxOutputTokens, affordable)
  return { ok: true, maxTokens, limited: maxTokens < input.maxOutputTokens }
}

/**
 * What a tool iteration must leave unspent so the turn can still close
 * with a model-written summary: the summary call's worst case, after
 * this iteration adds its full output and one round of tool results to
 * the prompt. Without it a turn could spend its whole budget on tool
 * calls and end on the deterministic fallback message.
 */
export function closeReserveUsd(model: string, prompt: PromptEstimate, maxOutputTokens: number): number {
  const pricing = pricingForModel(model)
  const closePrompt: PromptEstimate = {
    cached: prompt.cached + prompt.fresh,
    fresh: maxOutputTokens + CLOSE_TOOL_RESULT_ALLOWANCE_TOKENS,
  }
  return promptCostUsd(closePrompt, pricing) + outputFloorsFor(model).close * pricing.outputPerMTok / 1e6
}

export function usageCostUsd(model: string, usage: AIUsage): number {
  return estimateMessageCostUsd({ model, ...usage })
}

/**
 * Prompt estimate for the call after `previous`: everything the
 * previous call read or wrote to the cache is now cached; its uncached
 * input, its output and the tool results appended since are fresh.
 */
export function nextPromptEstimate(previous: AIUsage, appendedTokens: number): PromptEstimate {
  return {
    cached: previous.cacheReadInputTokens + previous.cacheCreationInputTokens,
    fresh: previous.inputTokens + previous.outputTokens + appendedTokens,
  }
}

const ZERO_USAGE: AIUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }

function addUsage(a: AIUsage, b: Partial<AIUsage> | undefined): AIUsage {
  return {
    inputTokens: a.inputTokens + (b?.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b?.outputTokens ?? 0),
    cacheCreationInputTokens: a.cacheCreationInputTokens + (b?.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: a.cacheReadInputTokens + (b?.cacheReadInputTokens ?? 0),
  }
}

/**
 * Running token totals of one turn, including the call in flight.
 *
 * Anthropic bills a call's prompt as soon as it starts and its output
 * as it is generated — also when the client disconnects or the turn
 * fails half way. The old settle only read the totals off the loop's
 * final `done` event, so a cancelled or failed turn was counted as a
 * flat 1 credit whatever it had cost. The tracker is updated as events
 * arrive: `message_start` books the prompt, streamed text and tool
 * input book an output estimate, `message_end` replaces the estimate
 * with the real figures. `snapshot()` is what the turn has cost so far,
 * at any point, and is what the chat route settles in `finally`.
 */
export class TurnUsageTracker {
  private completed: AIUsage = { ...ZERO_USAGE }
  private inFlight: AIUsage | null = null
  private inFlightOutputChars = 0

  startCall(usage: Partial<AIUsage> | undefined): void {
    this.inFlight = addUsage(ZERO_USAGE, usage)
    this.inFlightOutputChars = 0
  }

  addStreamedOutput(text: string | undefined): void {
    if (!text) return
    if (!this.inFlight) this.inFlight = { ...ZERO_USAGE }
    this.inFlightOutputChars += text.length
  }

  endCall(usage: Partial<AIUsage> | undefined): void {
    this.completed = addUsage(this.completed, usage)
    this.inFlight = null
    this.inFlightOutputChars = 0
  }

  /** Totals of completed calls only — what the provider has confirmed. */
  get confirmed(): AIUsage {
    return { ...this.completed }
  }

  snapshot(): AIUsage {
    if (!this.inFlight) return { ...this.completed }
    // Same ratio the history budget uses for ASCII text (~3.5 chars/token).
    const estimatedOutput = Math.ceil(this.inFlightOutputChars / 3.5)
    return addUsage(this.completed, {
      ...this.inFlight,
      outputTokens: Math.max(this.inFlight.outputTokens, estimatedOutput),
    })
  }
}
