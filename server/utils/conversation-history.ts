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

  'claude-sonnet-4-5': 40_000,
  'claude-sonnet-4-6': 48_000,

  'claude-opus-4-1-20250805': 32_000,
  'claude-opus-4-7': 48_000,
  'claude-opus-4-8': 48_000,
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

/**
 * Build the AI message list from persisted trace rows.
 *
 * Critical Anthropic protocol invariant: a `tool_use` block in an
 * assistant turn MUST be followed by a matching `tool_result` block
 * in the next user turn (or vice versa). If the row-level budget
 * walker drops a tool_use but keeps its tool_result — or worse, the
 * other way around — Anthropic rejects the request (or silently
 * mis-routes the conversation). So the budget cutoff operates at the
 * **turn** boundary, not the row boundary:
 *
 *   1. Group rows by `turn_id` (preserving DB order).
 *   2. Walk groups newest → oldest, summing per-group token estimates.
 *   3. Drop entire turns when the budget is exceeded — never half a turn.
 *   4. If the DB row_limit truncated mid-turn (rare), drop the
 *      partial leading turn so we never feed Anthropic a turn that
 *      starts with a tool_result without its matching tool_use.
 *   5. Materialize the kept groups in chronological order and append
 *      the current user message.
 *
 * Legacy rows (pre-009 migration) get distinct turn_ids via the
 * column's `gen_random_uuid()` default — each becomes a one-row
 * "turn" of its own. That's protocol-safe by definition (no tool
 * blocks were persisted on the legacy path).
 */
export function buildPromptMessages(input: {
  history: DatabaseRow[]
  /**
   * The current turn's user content. A plain string for text-only
   * messages, or an `AIContentBlock[]` when attachments are present
   * (attachment blocks followed by the user text). Sent in full — only
   * *historical* base64 images are stripped (see `extractContent`).
   */
  newUserMessage: string | AIContentBlock[]
  budget: HistoryBudget
}): AIMessage[] {
  const groups = groupRowsByTurn(input.history)
  const kept = selectTurnsWithinBudget(groups, input.budget.maxTokens)

  const messages: AIMessage[] = []
  for (const group of kept) {
    for (const row of group) {
      messages.push({
        role: row.role as 'user' | 'assistant',
        content: extractContent(row),
      })
    }
  }
  messages.push({ role: 'user', content: input.newUserMessage })
  return messages
}

/**
 * Content extraction priority: structured `content_blocks` jsonb
 * first (post-009 trace rows), then the legacy `tool_calls` /
 * `toolCalls` wrapper (only the final assistant turn ever wrote it),
 * finally plain text `content`.
 */
function extractContent(row: DatabaseRow): string | AIContentBlock[] {
  const blocks
    = (row.content_blocks ?? row.contentBlocks ?? row.tool_calls ?? row.toolCalls) as AIContentBlock[] | null | undefined
  if (blocks && Array.isArray(blocks) && blocks.length > 0) return stripHistoricalImageBytes(blocks)
  return row.content as string | AIContentBlock[]
}

/**
 * Replay-cost guard for attachment images. A base64 image persisted in
 * the seed user row would otherwise be re-sent — and re-billed — on
 * every subsequent turn, and (via `estimateGroupTokens`) could evict
 * real conversation history. So when replaying *historical* rows we
 * drop the inline bytes and leave a text placeholder. URL images are
 * kept verbatim: they are cheap (no payload, just a reference) and let
 * the CDN-backed path keep working across turns. The current turn's
 * content bypasses `extractContent`, so its images are always sent in
 * full — only history is stripped.
 */
export function stripHistoricalImageBytes(blocks: AIContentBlock[]): AIContentBlock[] {
  let stripped = false
  const out = blocks.map((block) => {
    if (block.type === 'image' && block.source.type === 'base64') {
      stripped = true
      return { type: 'text' as const, text: '[image attached earlier]' }
    }
    return block
  })
  return stripped ? out : blocks
}

function groupRowsByTurn(rows: DatabaseRow[]): DatabaseRow[][] {
  const groups: DatabaseRow[][] = []
  let current: DatabaseRow[] = []
  let currentTurn: string | null = null
  for (const row of rows) {
    const turn = (row.turn_id ?? row.turnId) as string | null | undefined
    // Treat null/undefined as the row's own group so legacy rows
    // (without turn_id) and rows with distinct ids both behave
    // protocol-safely.
    const key = (turn ?? `__row_${groups.length}_${current.length}`) as string
    if (key !== currentTurn) {
      if (current.length > 0) groups.push(current)
      current = []
      currentTurn = key
    }
    current.push(row)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

function selectTurnsWithinBudget(groups: DatabaseRow[][], maxTokens: number): DatabaseRow[][] {
  if (maxTokens <= 0) return []
  if (groups.length === 0) return groups
  let tokens = 0
  let cutoff = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    const groupTokens = estimateGroupTokens(groups[i]!)
    if (tokens + groupTokens > maxTokens) {
      cutoff = i + 1
      break
    }
    tokens += groupTokens
  }
  return groups.slice(cutoff)
}

function estimateGroupTokens(group: DatabaseRow[]): number {
  let total = 0
  for (const row of group) {
    const content = extractContent(row)
    total += typeof content === 'string'
      ? Math.ceil(content.length / 4)
      : Math.ceil(JSON.stringify(content).length / 4)
  }
  return total
}
