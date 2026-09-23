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

export interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  /**
   * Cache-read rate as a fraction of `inputPerMTok`. Absent = the
   * standard 0.1× (`CACHE_READ_MULTIPLIER` in `ai-credits.ts`). Opus 5.5
   * reads cache at 0.05× — a flat 0.1 would bill its cached history at
   * twice what Anthropic charges.
   */
  cacheReadMultiplier?: number
}

/**
 * How the provider adapter asks a model to think:
 * - `disabled`: sent as `thinking: { type: 'disabled' }`. Newer models
 *   default to adaptive thinking when the field is absent, so it is
 *   sent explicitly.
 * - `adaptive`: the model cannot turn thinking off (Opus 5.5 answers a
 *   `disabled` request with a 400). The adapter sends adaptive thinking
 *   with `effort`, and the engine carries the returned thinking blocks
 *   back unchanged — inside the tool loop and on replay.
 */
export type ModelThinkingMode = 'disabled' | 'adaptive'

export interface ChatModelEntry {
  /** Exact Anthropic model ID sent to the API. */
  id: string
  /** Short label shown in the model picker. */
  label: string
  /** One-line description shown in the picker. */
  description: string
  /**
   * Plan gate: `starter` models are available on every plan that can
   * chat; `pro` models additionally require the `ai.pro_models`
   * feature (pro/enterprise, and Community Edition where the operator
   * pays with their own key). The gate exists for unit economics: a
   * Sonnet/Opus message costs 3-10x a Haiku message.
   */
  tier: 'starter' | 'pro'
  /**
   * Premium models cost Studio the most per turn. A trial workspace on
   * the Studio-funded key cannot pick them (`chat.post.ts`); BYOA and
   * paid subscriptions can. The gate reads this flag, not a model-ID
   * list, so a future premium model is covered by its catalog entry.
   */
  premium?: boolean
  /** See `ModelThinkingMode`. Absent = `disabled`. */
  thinking?: ModelThinkingMode
  /**
   * `output_config.effort` for `adaptive` models. Set explicitly: Opus
   * 5.5's API default is `medium`, other models default to `high`.
   */
  effort?: 'low' | 'medium' | 'high'
  /**
   * Anthropic list price for this model, used by
   * `shared/utils/ai-credits.ts` to weigh a message's credit cost.
   * The cache-write multiplier lives in the credits helper; a
   * non-standard cache-read rate rides on the entry.
   */
  pricing: ModelPricing
  /**
   * Conversation-history token budget for this model — scaled by plan
   * and source in `server/utils/conversation-history.ts`.
   *
   * The replayed history is served from the prompt cache (1h TTL, see
   * `PROMPT_CACHE_CONTROL`), so its steady-state cost is ~0.1× the
   * base input price: 96K of cached Sonnet history is ~$0.02 per call.
   * What the budget really bounds is the cost of a cache MISS (a gap
   * over an hour, or a hysteresis trim), which re-writes the whole
   * window at 2× — and the total context, which must stay well under
   * the 200K long-context pricing boundary together with system prompt,
   * tools, the current turn and tool results.
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
   * output limit (Haiku 64K, Sonnet 5 / Opus 5.5 128K). On an `adaptive`
   * model the thinking tokens count toward this ceiling too.
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
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
    historyBudget: 24_000,
    maxOutputTokens: 16_000,
    paletteIcon: 'icon-[annon--lightning]',
    paletteKeywords: ['haiku', 'fast', 'economic'],
  },
  {
    // $2/$10 — launched as introductory pricing through 2026-08-31,
    // now confirmed permanent (Anthropic cancelled the scheduled
    // increase to Sonnet 4.6's $3/$15 sticker; see
    // platform.claude.com/docs/en/about-claude/pricing, "Claude
    // Sonnet 5 introductory pricing" note). New tokenizer produces
    // ~30% more tokens for the same text — the shared budget
    // therefore holds less conversation text than on 4.6, which
    // keeps cost roughly at par despite the lower sticker.
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    description: 'Balanced, newest generation',
    tier: 'pro',
    pricing: { inputPerMTok: 2, outputPerMTok: 10 },
    historyBudget: 96_000,
    maxOutputTokens: 16_000,
    paletteIcon: 'icon-[annon--star]',
    paletteKeywords: ['sonnet', 'balanced', 'newest', 'sonnet 5'],
  },
  {
    // $4/$20, cache reads at 0.05× ($0.20/MTok — the same absolute rate
    // as Sonnet 5), so replayed history costs no more than on Sonnet;
    // the premium is in output and uncached input. Thinking is always
    // on for this model (see `ModelThinkingMode`).
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    description: 'Most capable',
    tier: 'pro',
    premium: true,
    thinking: 'adaptive',
    effort: 'medium',
    pricing: { inputPerMTok: 4, outputPerMTok: 20, cacheReadMultiplier: 0.05 },
    historyBudget: 96_000,
    maxOutputTokens: 32_000,
    paletteIcon: 'icon-[annon--trophy]',
    paletteKeywords: ['opus', 'capable', 'best'],
  },
]

/**
 * Default model when the client didn't pick one or picked one its plan
 * doesn't grant. Must be a `CHAT_MODELS` id.
 */
export const DEFAULT_CHAT_MODEL = 'claude-sonnet-5'

/**
 * Model IDs available to a plan, given whether it has the
 * `ai.pro_models` feature (resolved via `hasFeature` by the caller).
 * Starter-tier models are always included — every plan that can chat
 * at all can use them. `premium: false` also leaves out premium models
 * (a trial on the Studio-funded key, see `premiumModelsAllowed`).
 */
export function chatModelIdsFor(hasProModels: boolean, opts: { premium?: boolean } = {}): string[] {
  return CHAT_MODELS
    .filter(m => hasProModels || m.tier === 'starter')
    .filter(m => opts.premium !== false || !m.premium)
    .map(m => m.id)
}

/**
 * Premium models are closed during a trial when Studio pays for the
 * tokens: trial usage is never billed, and an Opus turn costs about
 * twice a Sonnet one. A BYOA key pays for itself, so it keeps them, and
 * so does every paid state.
 */
export function premiumModelsAllowed(input: { billingState?: string | null, usageSource: 'byoa' | 'studio' }): boolean {
  return !(input.billingState === 'trial_active' && input.usageSource === 'studio')
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

/** Thinking mode for a model ID; legacy and Conversation-API IDs are `disabled`. */
export function thinkingModeFor(modelId: string): ModelThinkingMode {
  return CHAT_MODELS.find(m => m.id === modelId)?.thinking ?? 'disabled'
}

/** `output_config.effort` for an `adaptive` model, or undefined. */
export function effortFor(modelId: string): ChatModelEntry['effort'] {
  return CHAT_MODELS.find(m => m.id === modelId)?.effort
}

/** Whether a model ID is a premium catalog model (see `ChatModelEntry.premium`). */
export function isPremiumModel(modelId: string): boolean {
  return CHAT_MODELS.some(m => m.id === modelId && m.premium === true)
}
