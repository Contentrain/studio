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
  /**
   * A second rate card for long prompts. Anthropic prices each request on
   * its own: a request whose prompt (uncached input + cache writes + cache
   * reads) is over `overTokens` pays these rates on ALL of its tokens,
   * output included; the cache multipliers apply on top as usual.
   * Haiku 5.5: $0.10/$0.50 up to 100K, $0.50/$2.50 over it. Absent = one
   * card at any prompt length. See `ratesForPrompt` in `ai-credits.ts`.
   */
  longPrompt?: {
    overTokens: number
    inputPerMTok: number
    outputPerMTok: number
  }
}

/**
 * How the provider adapter asks a model to think:
 * - `disabled`: sent as `thinking: { type: 'disabled' }`. Only for model
 *   IDs outside the catalog (legacy / unknown). The 5.5 models either
 *   reject it (Opus 5.5 and Sonnet 5.5 answer it with a 400) or are
 *   steered by effort instead (Haiku 5.5).
 * - `adaptive`: the adapter sends adaptive thinking with `effort`, and
 *   the engine carries the returned thinking blocks back unchanged —
 *   inside the tool loop and on replay. Every catalog model runs this
 *   way: it is the only mode that accepts `block_binding: drop_block`,
 *   which Studio's replay needs (`requestThinking` in `anthropic-ai.ts`).
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
   * Sonnet/Opus message costs 20-40x a Haiku message at list price.
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
   * `output_config.effort` for `adaptive` models. Always set explicitly:
   * the API defaults differ (Opus 5.5 and Haiku 5.5 `medium`, Sonnet 5.5
   * `high`, with levels recalibrated against Sonnet 5). Never change it
   * mid-conversation: a different top-level effort invalidates the
   * prompt cache.
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
   * the long-prompt price boundary (Haiku 5.5: 100K per request, see
   * `ModelPricing.longPrompt`) together with system prompt, tools, the
   * current turn and tool results.
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
   * output limit (128K on all three 5.5 models). On an `adaptive` model
   * the thinking tokens count toward this ceiling too.
   */
  maxOutputTokens: number
  /** Command palette icon class. */
  paletteIcon: string
  /** Command palette search keywords (base set; palette adds generics). */
  paletteKeywords: string[]
}

export const CHAT_MODELS: readonly ChatModelEntry[] = [
  {
    // $0.10/$0.50 for a prompt up to 100K tokens, $0.50/$2.50 over it
    // (per request, cache reads and writes counted in the prompt). The
    // 24K history budget keeps a normal call well under 100K, but a long
    // tool loop can cross it, so the long card is priced too. Its
    // tokenizer counts the same text as ~30% more tokens than Haiku 4.5.
    // Adaptive at `low` effort: the documented level for chat and short
    // tool tasks, and the cheapest one.
    id: 'claude-haiku-5-5',
    label: 'Haiku 5.5',
    description: 'Fast & economic',
    tier: 'starter',
    thinking: 'adaptive',
    effort: 'low',
    pricing: {
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
      longPrompt: { overTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 },
    },
    historyBudget: 24_000,
    maxOutputTokens: 16_000,
    paletteIcon: 'icon-[annon--lightning]',
    paletteKeywords: ['haiku', 'fast', 'economic', 'haiku 5.5'],
  },
  {
    // $2/$10 like Sonnet 5, cache reads at 0.05× ($0.10/MTok, pricing
    // page footnote 2). `thinking: disabled` is a 400 on this model, so
    // it runs adaptive at `medium` — the documented starting point for
    // multistep tool use. Same tokenizer as Sonnet 5. The output ceiling
    // matches Opus because thinking now counts toward it.
    id: 'claude-sonnet-5-5',
    label: 'Sonnet 5.5',
    description: 'Balanced, newest generation',
    tier: 'pro',
    thinking: 'adaptive',
    effort: 'medium',
    pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheReadMultiplier: 0.05 },
    historyBudget: 96_000,
    maxOutputTokens: 32_000,
    paletteIcon: 'icon-[annon--star]',
    paletteKeywords: ['sonnet', 'balanced', 'newest', 'sonnet 5.5'],
  },
  {
    // $4/$20, cache reads at 0.05× ($0.20/MTok), so replayed history is
    // cheap; the premium is in output and uncached input. Thinking is
    // always on for this model (see `ModelThinkingMode`).
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
export const DEFAULT_CHAT_MODEL = 'claude-sonnet-5-5'

/**
 * Model families the catalog carries one current model of. A retired ID
 * of a family (`claude-haiku-4-5-20251001`, `claude-sonnet-5`,
 * `claude-opus-4-8`, `claude-3-5-sonnet-20241022`, ...) resolves to it.
 */
const FAMILY_PATTERN = /^claude-(?:\d+(?:-\d+)?-)?(haiku|sonnet|opus)(?:-|$)/

/**
 * The catalog model a stored or requested model ID runs on, or null.
 *
 * Model IDs outlive the catalog: a user's saved pick (localStorage), a
 * Conversation API key's `ai_model`, an API client that still sends an
 * old ID. A catalog ID comes back as is; a retired ID of a catalog
 * family moves to that family's current model, so the user keeps the
 * tier they picked instead of failing at the provider or jumping to the
 * default. Anything else (another family, a typo) is null and the
 * caller falls back to its default, as before. The result still goes
 * through the plan gate (`chatModelIdsFor`).
 */
export function resolveChatModelId(id: string | null | undefined): string | null {
  if (!id) return null
  if (CHAT_MODELS.some(m => m.id === id)) return id
  const family = FAMILY_PATTERN.exec(id)?.[1]
  if (!family) return null
  return CHAT_MODELS.find(m => m.id.startsWith(`claude-${family}-`))?.id ?? null
}

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
 * (legacy / unknown models). Safe for every current Claude
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

/** Thinking mode for a model ID; IDs outside the catalog are `disabled`. */
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
