/**
 * Chat model catalog — single source of truth.
 *
 * Every surface that deals with the chat model list derives from this
 * catalog: the composer picker (`useChat.AI_MODELS`), the command
 * palette (`app/utils/command-registry.ts`), the server-side plan gate
 * (`chat.post.ts`), and the per-model history budgets
 * (`server/utils/conversation-history.ts`). Adding or retiring a chat
 * model is one entry here — no other file changes.
 *
 * The list is deliberately curated rather than fetched from the
 * Anthropic Models API (`GET /v1/models`): each entry encodes Studio
 * policy the API cannot know — which plan tier may use the model, how
 * much history budget its pricing supports, and how it is presented.
 * A dynamic catalog would silently expose new (and possibly far more
 * expensive) models to paying workspaces the moment Anthropic ships
 * them, changing unit economics without review.
 */

export interface ChatModelEntry {
  /** Exact Anthropic model ID sent to the API. */
  id: string
  /** Short label shown in the model picker. */
  label: string
  /** One-line description shown in the picker. */
  description: string
  /**
   * Plan gate: `starter` models are available on every paid plan;
   * `pro` models additionally require the `ai.studio_key` feature.
   */
  tier: 'starter' | 'pro'
  /**
   * Conversation-history token budget for this model — scaled by plan
   * and source in `server/utils/conversation-history.ts`.
   */
  historyBudget: number
  /**
   * Output-token ceiling (`max_tokens`) sent to the provider for this
   * model. This is a CAP, not a target — the model bills only for what
   * it actually generates, so a generous ceiling is cost-neutral for
   * normal turns and only matters when a single response (notably a
   * large write tool call — a full dictionary, many entries) would
   * otherwise be cut off mid-generation. Too small a value silently
   * truncates the tool call and the operation never runs; too large a
   * value risks a provider 400 for exceeding the model's own limit.
   * Values here stay comfortably within every listed model's documented
   * output limit (Sonnet/Haiku 64K, Opus 32K).
   */
  maxOutputTokens: number
  /** Command palette icon class. */
  paletteIcon: string
  /** Command palette search keywords (base set; palette adds generics). */
  paletteKeywords: string[]
}

export const CHAT_MODELS: readonly ChatModelEntry[] = [
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    description: 'Fast & economic',
    tier: 'starter',
    historyBudget: 12_000,
    maxOutputTokens: 16_000,
    paletteIcon: 'icon-[annon--lightning]',
    paletteKeywords: ['haiku', 'fast', 'economic'],
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    description: 'Balanced',
    tier: 'pro',
    historyBudget: 48_000,
    maxOutputTokens: 16_000,
    paletteIcon: 'icon-[annon--star]',
    paletteKeywords: ['sonnet', 'balanced'],
  },
  {
    // Same $3/$15 sticker as Sonnet 4.6 (intro $2/$10 through
    // 2026-08-31) but a new tokenizer that produces ~30% more tokens
    // for the same text — the shared 48K budget therefore holds less
    // conversation text than on 4.6, which keeps cost roughly at par.
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    description: 'Balanced, newest generation',
    tier: 'pro',
    historyBudget: 48_000,
    maxOutputTokens: 16_000,
    paletteIcon: 'icon-[annon--star]',
    paletteKeywords: ['sonnet', 'balanced', 'newest', 'sonnet 5'],
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    description: 'Most capable',
    tier: 'pro',
    historyBudget: 48_000,
    maxOutputTokens: 16_000,
    paletteIcon: 'icon-[annon--trophy]',
    paletteKeywords: ['opus', 'capable', 'best'],
  },
]

/**
 * Default model when the client didn't pick one or picked one its plan
 * doesn't grant. Must be a `CHAT_MODELS` id.
 */
export const DEFAULT_CHAT_MODEL = 'claude-sonnet-4-6'

/**
 * Model IDs available to a plan, given whether it has the
 * `ai.studio_key` feature (resolved via `hasFeature` by the caller).
 */
export function chatModelIdsFor(hasStudioKey: boolean): string[] {
  return CHAT_MODELS.filter(m => hasStudioKey || m.tier === 'starter').map(m => m.id)
}

/**
 * Fallback output-token ceiling for model IDs not in the chat catalog
 * (Conversation-API / legacy models). Safe for every current Claude
 * model and still double the historical 4K default the tool loop used.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192

/**
 * Output-token ceiling (`max_tokens`) for a model. Catalog-driven for
 * chat-picker models; `DEFAULT_MAX_OUTPUT_TOKENS` for anything else
 * (legacy / Conversation-API model IDs). See `ChatModelEntry.maxOutputTokens`.
 */
export function maxOutputTokensFor(modelId: string): number {
  return CHAT_MODELS.find(m => m.id === modelId)?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
}
