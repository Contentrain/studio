/**
 * Shared chat-history builder.
 *
 * Both the Studio chat handler and the Conversation API handler load
 * prior messages from `messages`, walk them back-to-front under a
 * token ceiling, and append the current user message. The duplicate
 * lived in two files with a hard-coded 8K budget, a magic 50-row cap,
 * and divergent `tool_calls`/`toolCalls` casing — see `chat.post.ts`
 * pre-refactor and `ee/enterprise/conversation-api.ts`.
 *
 * Two pure helpers consolidate the logic:
 *
 *   - `selectHistoryBudget({ plan, model, source })` returns the
 *     model-aware token ceiling, scaled by plan and source. Model
 *     drives capability; plan drives Contentrain's per-message
 *     margin; source drives who pays.
 *   - `buildPromptMessages({ history, newUserMessage, budget })`
 *     converts DB rows into the `AIMessage[]` shape the provider
 *     contract expects, slicing oldest rows when the budget runs out.
 *
 * No DB, no provider — pure functions, unit-testable.
 */
import type { AIContentBlock, AIMessage } from '../providers/ai'
import type { DatabaseRow } from '../providers/database'

export interface HistoryBudget {
  /** Approximate input-token ceiling for the entire history block. */
  maxTokens: number
  /**
   * Upper bound on rows fetched from DB. The token cutoff does the
   * real work; this is a safety bound against pathologically long
   * conversations. Scales with `maxTokens`.
   */
  rowLimit: number
}

/**
 * Per-model history budgets, picked conservatively to leave headroom
 * for system prompt (5-15K with the brain content index), tools
 * (~2K), the new user message, and 2-4K of output.
 *
 * Sonnet/Opus values stay well below the 200K long-context boundary
 * because that tier carries premium pricing. Once prompt caching
 * (per-block `cache_control`) lands these can grow — cache reads cost
 * ~10% of base input, so the same dollar of input buys a much larger
 * effective window. Until then, conservative is right.
 *
 * Sources: claude.com/docs/en/about-claude/models/overview and
 * claude.com/docs/en/about-claude/pricing.
 */
const MODEL_HISTORY_BUDGETS: Record<string, number> = {
  'claude-haiku-4-5-20251001': 12_000,

  'claude-sonnet-4-20250514': 32_000,
  'claude-sonnet-4-5': 40_000,
  'claude-sonnet-4-6': 48_000,

  'claude-opus-4-20250514': 32_000,
  'claude-opus-4-1-20250805': 32_000,
  'claude-opus-4-7': 48_000,
}

/** Unknown model IDs (future / preview) get the same starting point as Haiku. */
const FALLBACK_BUDGET = 16_000

/**
 * Source axis: who pays for the input tokens.
 *
 *  - studio: Contentrain pays. Default budget.
 *  - api: workspace pays via its plan + overage. Default budget.
 *  - byoa: workspace user pays Anthropic directly; we can afford to
 *    send more history because the marginal cost is on them.
 */
const SOURCE_MULTIPLIER: Record<'studio' | 'byoa' | 'api', number> = {
  studio: 1,
  api: 1,
  byoa: 1.5,
}

/**
 * Plan axis: matches Studio's per-message margin posture.
 * `free` evaluates to 0 by design — free tier should never reach this
 * code path (gated upstream by feature/limit checks). If something
 * routes free traffic here, history degrades to "only the current
 * user message" rather than fabricating budget the plan doesn't fund.
 */
const PLAN_MULTIPLIER: Record<string, number> = {
  free: 0,
  starter: 0.75,
  pro: 1,
  enterprise: 1.25,
  community: 1,
}
const FALLBACK_PLAN_MULTIPLIER = 1

export function selectHistoryBudget(input: {
  plan: string
  model: string
  source: 'studio' | 'byoa' | 'api'
}): HistoryBudget {
  const base = MODEL_HISTORY_BUDGETS[input.model] ?? FALLBACK_BUDGET
  const planMul = PLAN_MULTIPLIER[input.plan] ?? FALLBACK_PLAN_MULTIPLIER
  const sourceMul = SOURCE_MULTIPLIER[input.source]
  const maxTokens = Math.floor(base * planMul * sourceMul)
  // ~120 tokens per row floor (short user/assistant message) — bounds
  // DB pagination without ever undercutting what the budget can hold.
  const rowLimit = Math.max(50, Math.ceil(maxTokens / 120))
  return { maxTokens, rowLimit }
}

export function buildPromptMessages(input: {
  history: DatabaseRow[]
  newUserMessage: string
  budget: HistoryBudget
}): AIMessage[] {
  const messages: AIMessage[] = []
  const cutoff = findBudgetCutoff(input.history, input.budget.maxTokens)
  for (let i = cutoff; i < input.history.length; i++) {
    const row = input.history[i]!
    messages.push({
      role: row.role as 'user' | 'assistant',
      content: extractContent(row),
    })
  }
  messages.push({ role: 'user', content: input.newUserMessage })
  return messages
}

/**
 * Tolerates both `tool_calls` (Studio path — `db.loadConversationMessages`
 * returns snake_case rows) and `toolCalls` (EE handler's pre-refactor
 * wrapper renamed it). Once that wrapper is gone the second branch is
 * dead — leave it as a safety net for any external caller.
 */
function extractContent(row: DatabaseRow): string | AIContentBlock[] {
  const blocks = (row.tool_calls ?? row.toolCalls) as AIContentBlock[] | null | undefined
  if (blocks && Array.isArray(blocks) && blocks.length > 0) return blocks
  return row.content as string | AIContentBlock[]
}

function findBudgetCutoff(history: DatabaseRow[], maxTokens: number): number {
  if (maxTokens <= 0) return history.length
  let tokens = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i]!
    const content = extractContent(row)
    const estimate = typeof content === 'string'
      ? Math.ceil(content.length / 4)
      : Math.ceil(JSON.stringify(content).length / 4)
    tokens += estimate
    if (tokens > maxTokens) return i + 1
  }
  return 0
}
