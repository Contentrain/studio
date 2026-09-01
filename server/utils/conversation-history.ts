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
 * Pure helpers consolidate the logic:
 *
 *   - `selectHistoryBudget({ plan, model, source })` returns the
 *     model-aware token ceiling, scaled by plan and source. Model
 *     drives capability; plan drives Contentrain's per-message
 *     margin; source drives who pays.
 *   - `buildPromptMessages({ history, newUserMessage, budget,
 *     requestContext })` converts DB rows into the `AIMessage[]`
 *     shape the provider contract expects, trims oldest turns when
 *     the budget runs out, and assembles the prompt-cache layout.
 *
 * Prompt-cache layout (see CLAUDE.md "Chat Prompt Cache Layout"):
 * the replayed history is the cacheable prefix. The last block of the
 * newest kept history message carries `PROMPT_CACHE_CONTROL`, so a
 * call only pays full price for what changed since the previous one.
 * Three things keep that prefix stable:
 *
 *   1. Trimming uses hysteresis — once the history overflows, it is
 *      cut to `HISTORY_TRIM_TARGET` of the budget rather than to the
 *      budget itself. Trimming exactly to the budget every turn would
 *      drop one old turn per call, shift the prefix, and re-write the
 *      entire window on every request.
 *   2. Per-request context (content index, UI state, intent, project
 *      state) goes into the CURRENT user turn, after the prefix —
 *      never into `system`, where it would precede every history
 *      message and invalidate the cache whenever content changes.
 *   3. Rows are replayed exactly as persisted; the Anthropic adapter
 *      canonicalizes key order so jsonb round-trips stay byte-stable.
 *
 * No DB, no provider — pure functions, unit-testable.
 */
import type { AIContentBlock, AIMessage } from '../providers/ai'
import { PROMPT_CACHE_CONTROL } from '../providers/ai'
import type { DatabaseRow } from '../providers/database'
import { CHAT_MODELS } from '../../shared/utils/ai-models'

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
 * Per-model history budgets. The chat-picker models carry theirs on
 * the shared catalog (`shared/utils/ai-models.ts`, with the pricing
 * rationale); the entries below are Conversation-API / legacy models
 * not offered in the picker.
 *
 * Budgets leave headroom under the 200K long-context boundary for the
 * system prompt, tools (~20K cached together), the current turn with
 * its attachments, tool results and output.
 */
const MODEL_HISTORY_BUDGETS: Record<string, number> = {
  // Chat-picker models — budgets live on the shared catalog entries.
  ...Object.fromEntries(CHAT_MODELS.map(m => [m.id, m.historyBudget])),

  // Conversation-API / legacy models not offered in the chat picker.
  'claude-sonnet-4-5': 40_000,
  'claude-opus-4-1-20250805': 32_000,
  'claude-opus-4-7': 48_000,
}

/** Unknown model IDs (future / preview) get a conservative starting point. */
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

/**
 * When the history overflows `maxTokens`, keep only this share of the
 * budget. The slack is what lets the cached prefix survive the next
 * several turns instead of shifting on every call.
 */
const HISTORY_TRIM_TARGET = 0.75

/**
 * Newest history turns whose URL images are replayed as real images.
 * Anthropic bills a URL image by pixel count exactly like an inline
 * one (~1,600 tokens after its own downscale), so a cover image
 * attached 40 turns ago would otherwise be re-billed on every call.
 * The most recent turn keeps its images so a follow-up about the file
 * just attached ("write the alt text") still sees it; older ones are
 * replaced by a placeholder that keeps the URL as a reference.
 */
const RECENT_IMAGE_TURNS = 1

/**
 * Token estimate for one image block. Anthropic scales every image to
 * at most ~1.15 megapixels and bills ~1 token per 750 pixels, so this
 * is the ceiling regardless of the source file's size.
 */
const IMAGE_TOKEN_ESTIMATE = 1_600

/** Per-message framing overhead (role tokens, block separators). */
const MESSAGE_OVERHEAD_TOKENS = 4

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
 *   2. Materialize each turn (image replay policy applied per turn).
 *   3. Walk turns newest → oldest under the budget; on overflow, cut
 *      down to `HISTORY_TRIM_TARGET` of it (hysteresis). Drop entire
 *      turns — never half a turn.
 *   4. If the DB row_limit truncated mid-turn (rare), drop the
 *      partial leading turn so we never feed Anthropic a turn that
 *      starts with a tool_result without its matching tool_use.
 *   5. Mark the tail of the kept history as the cache breakpoint and
 *      append the current user turn (request context first, then the
 *      attachments and the user text).
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
   * *historical* images are stripped (see `stripHistoricalImages`).
   */
  newUserMessage: string | AIContentBlock[]
  budget: HistoryBudget
  /**
   * Per-request context assembled by `buildRequestContext` (content
   * index, UI context, inferred intent, project state). Prepended to
   * the current user turn as a text block so it sits AFTER the cached
   * history prefix. It is never persisted — the seed user row keeps
   * only the user's own content.
   */
  requestContext?: string | null
}): AIMessage[] {
  const groups = groupRowsByTurn(input.history)
  const turns = groups.map((group, index) => {
    const keepUrlImages = index >= groups.length - RECENT_IMAGE_TURNS
    return group.map((row): AIMessage => ({
      role: row.role as 'user' | 'assistant',
      content: extractContent(row, keepUrlImages),
    }))
  })
  const kept = selectTurnsWithinBudget(turns, input.budget.maxTokens)

  const messages = kept.flat()
  const tail = messages.length - 1
  if (tail >= 0) messages[tail] = withCacheMarker(messages[tail]!)
  messages.push({ role: 'user', content: withRequestContext(input.newUserMessage, input.requestContext) })
  return messages
}

/**
 * Content extraction priority: structured `content_blocks` jsonb
 * first (post-009 trace rows), then the legacy `tool_calls` /
 * `toolCalls` wrapper (only the final assistant turn ever wrote it),
 * finally plain text `content`.
 */
function extractContent(row: DatabaseRow, keepUrlImages: boolean): string | AIContentBlock[] {
  const blocks
    = (row.content_blocks ?? row.contentBlocks ?? row.tool_calls ?? row.toolCalls) as AIContentBlock[] | null | undefined
  if (blocks && Array.isArray(blocks) && blocks.length > 0) return stripHistoricalImages(blocks, { keepUrlImages })
  return row.content as string | AIContentBlock[]
}

/**
 * Replay-cost guard for attachment images.
 *
 * - base64 images are always replaced by a placeholder: re-sending the
 *   bytes would re-bill the image on every subsequent turn and, via
 *   the token estimate, evict real conversation history.
 * - URL images are billed exactly the same way (the provider fetches
 *   and tokenizes them), so they get the same treatment once the turn
 *   is older than `RECENT_IMAGE_TURNS`. The placeholder keeps the URL
 *   so the model can still refer to the asset.
 * - Documents (PDF) stay: the model may need them for follow-ups, and
 *   inside the cached prefix they cost ~0.1× after the first call.
 *
 * The current turn's content bypasses this function, so its images
 * are always sent in full — only history is stripped. Returns the
 * input array untouched when nothing changed.
 */
export function stripHistoricalImages(blocks: AIContentBlock[], opts: { keepUrlImages: boolean }): AIContentBlock[] {
  let stripped = false
  const out = blocks.map((block): AIContentBlock => {
    if (block.type !== 'image') return block
    if (block.source.type === 'base64') {
      stripped = true
      return { type: 'text', text: '[image attached earlier]' }
    }
    if (opts.keepUrlImages) return block
    stripped = true
    return { type: 'text', text: `[image attached earlier: ${block.source.url}]` }
  })
  return stripped ? out : blocks
}

/**
 * Place the prompt-cache breakpoint on the tail of the replayed
 * history: the last non-empty block of the newest kept message. A
 * plain-string message becomes a single text block so it can carry
 * the marker (the two shapes are equivalent on the wire).
 */
function withCacheMarker(message: AIMessage): AIMessage {
  if (typeof message.content === 'string') {
    if (!message.content.trim()) return message
    return { role: message.role, content: [{ type: 'text', text: message.content, cacheControl: PROMPT_CACHE_CONTROL }] }
  }
  for (let i = message.content.length - 1; i >= 0; i--) {
    const block = message.content[i]!
    if (block.type === 'text' && !block.text.trim()) continue
    const content = message.content.slice()
    content[i] = { ...block, cacheControl: PROMPT_CACHE_CONTROL }
    return { role: message.role, content }
  }
  return message
}

/** Prepend the per-request context block to the current user turn. */
function withRequestContext(
  newUserMessage: string | AIContentBlock[],
  requestContext: string | null | undefined,
): string | AIContentBlock[] {
  if (!requestContext || !requestContext.trim()) return newUserMessage
  const context: AIContentBlock = { type: 'text', text: requestContext }
  return typeof newUserMessage === 'string'
    ? [context, { type: 'text', text: newUserMessage }]
    : [context, ...newUserMessage]
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

/**
 * Newest-first selection under the budget with hysteresis: when the
 * whole history fits, keep all of it; when it doesn't, keep the newest
 * turns that fit in `HISTORY_TRIM_TARGET × maxTokens`. The newest turn
 * alone is measured against the full budget, so one large turn (a big
 * tool result, say) is never thrown away while it still fits.
 */
function selectTurnsWithinBudget(turns: AIMessage[][], maxTokens: number): AIMessage[][] {
  if (maxTokens <= 0 || turns.length === 0) return []
  const sizes = turns.map(estimateTurnTokens)
  const total = sizes.reduce((sum, n) => sum + n, 0)
  if (total <= maxTokens) return turns

  const target = Math.floor(maxTokens * HISTORY_TRIM_TARGET)
  let tokens = 0
  let cutoff = turns.length
  for (let i = turns.length - 1; i >= 0; i--) {
    const limit = i === turns.length - 1 ? maxTokens : target
    if (tokens + sizes[i]! > limit) break
    tokens += sizes[i]!
    cutoff = i
  }
  return turns.slice(cutoff)
}

function estimateTurnTokens(turn: AIMessage[]): number {
  let total = 0
  for (const message of turn) total += MESSAGE_OVERHEAD_TOKENS + estimateContentTokens(message.content)
  return total
}

/**
 * Approximate the input tokens a message body will cost. Exported for
 * tests; the budget walker is the only production caller.
 */
export function estimateContentTokens(content: string | AIContentBlock[]): number {
  if (typeof content === 'string') return estimateTextTokens(content)
  let total = 0
  for (const block of content) total += estimateBlockTokens(block)
  return total
}

function estimateBlockTokens(block: AIContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text)
    case 'image':
      return IMAGE_TOKEN_ESTIMATE
    case 'document':
      // ~1.5–3K tokens per page; base64 length is the only signal here.
      return Math.max(1_500, Math.ceil(block.source.data.length / 5))
    case 'tool_use':
      return 16 + estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.input))
    case 'tool_result':
      return 16 + estimateTextTokens(block.content)
    default:
      return 0
  }
}

/**
 * Characters-per-token heuristic that does not assume English. ASCII
 * text and JSON run ~3.5 chars/token; non-ASCII text (Turkish
 * diacritics, CJK, emoji) tokenizes far denser — treating it as 4
 * chars/token under-counted a Turkish editorial session by ~2× and
 * let the history grow past 150K tokens against a 48K budget.
 */
function estimateTextTokens(text: string): number {
  let nonAscii = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7F) nonAscii++
  }
  const ascii = text.length - nonAscii
  return Math.ceil(ascii / 3.5 + nonAscii / 1.2)
}
