/**
 * Plan & feature flag system — single source of truth.
 *
 * All per-plan values (pricing, feature flags, numeric limits, overage
 * prices) are derived from the `.contentrain/` content layer at build
 * time. Concretely:
 *
 *   `.contentrain/content/system/plans/en.json`          → PLAN_PRICING
 *   `.contentrain/content/system/plan-features/data.json` → FEATURE_MATRIX
 *                                                         + PLAN_LIMITS
 *                                                         + OVERAGE_PRICING
 *
 * This module re-exports the same public API as before; call sites
 * (`hasFeature`, `getPlanLimit`, `getPlanParams`, …) do not change.
 * Editing a plan price or a feature row in Contentrain (via MCP) is
 * enough — no code edit needed. The Polar sync script reads the same
 * content to keep Polar products / prices aligned.
 *
 * Plans:
 *   - free        — structural signup shell; deliberately ABSENT from
 *                   every feature row and zero across every limit
 *                   except `team.members` (one owner seat keeps the
 *                   workspace row valid). Developer signups convert
 *                   via the 14-day trial on a paid plan.
 *   - starter     — $9/mo, 3 seats, solo developer sizing
 *   - pro         — $49/mo, 25 seats, team sizing (3× of the old $29 Pro)
 *   - enterprise  — custom pricing, unlimited where it makes sense,
 *                   plus SSO / white-label / custom CDN domain
 *
 * Legacy plan names (`business`, `team`) map to `pro` via `normalizePlan`.
 */

import plansData from '../../.contentrain/content/system/plans/en.json'
import planFeaturesData from '../../.contentrain/content/system/plan-features/data.json'

/**
 * All runtime plan tiers. `community` is the AGPL-only self-host tier
 * and is assigned automatically when the enterprise bridge is absent;
 * it is not purchasable on the managed service.
 */
export type StudioPlan = 'community' | 'free' | 'starter' | 'pro' | 'enterprise'

/**
 * Edition gates whether ee/-dependent features are usable at runtime.
 *   'ee'   — enterprise bridge loaded; respect plan-tier gating.
 *   'agpl' — bridge absent; force-disable every `requires_ee` feature.
 *
 * Pass `{ edition }` to `hasFeature` / `getPlanLimit` so matrix rows
 * that claim `requires_ee: true` are filtered out in Community Edition.
 * The helpers default to `'ee'` to preserve existing call sites in the
 * managed service; server code that has access to `resolveDeployment()`
 * should pass the real edition explicitly.
 */
export type Edition = 'ee' | 'agpl'

const PLAN_SLUGS: readonly StudioPlan[] = ['community', 'free', 'starter', 'pro', 'enterprise']

// ─── Content shape (narrow types — JSON literal widening) ───

interface PlanContent {
  name: string
  price_monthly: number
  seats_included: number
  ai_model_tier: string
  badge_text: string
  cta_text: string
  description: string
  has_trial?: boolean
  is_highlighted?: boolean
  slug: string
  sort_order: number
}

interface PlanFeatureContent {
  key: string
  name: string
  type: 'feature' | 'limit'
  category: string
  community_value: string
  free_value: string
  starter_value: string
  pro_value: string
  enterprise_value: string
  requires_ee: string
  roadmap?: string
  overage_price?: number
  overage_unit?: string
  overage_settings_key?: string
  trial_cap_plan?: string
  trial_cap_origins?: string
  sort_order: number
}

const plans = plansData as unknown as Record<StudioPlan, PlanContent>
const planFeatures = planFeaturesData as unknown as Record<string, PlanFeatureContent>

// ─── Derivation helpers ───

function parseBoolValue(v: string): boolean {
  return v === 'true'
}

function parseLimitValue(v: string): number {
  if (v === 'unlimited') return Infinity
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function valueForPlan(row: PlanFeatureContent, plan: StudioPlan): string {
  switch (plan) {
    case 'community': return row.community_value
    case 'free': return row.free_value
    case 'starter': return row.starter_value
    case 'pro': return row.pro_value
    case 'enterprise': return row.enterprise_value
  }
}

// ─── Derived matrices ───

/**
 * Plan pricing: name + monthly price + included seats per plan.
 * Derived from `plans/en.json`.
 *
 * Enterprise carries `priceMonthly: 0` / `seatsIncluded: 0` as sentinels
 * for "contact sales" — callers must not display these as real numbers.
 * Community carries the same zeroed pricing; it is not purchasable and
 * is only ever assigned automatically in Community Edition.
 */
export const PLAN_PRICING: Record<StudioPlan, { priceMonthly: number, seatsIncluded: number, name: string }>
  = Object.fromEntries(
    PLAN_SLUGS.map(plan => [plan, {
      priceMonthly: plans[plan].price_monthly,
      seatsIncluded: plans[plan].seats_included,
      name: plans[plan].name,
    }]),
  ) as Record<StudioPlan, { priceMonthly: number, seatsIncluded: number, name: string }>

/**
 * Feature matrix: which plans grant each feature flag, plus the
 * `requires_ee` and `roadmap` flags per row. Derived from
 * plan-features rows with `type: 'feature'`.
 *
 * The matrix layer does NOT filter `requires_ee` — that decision is
 * made by `hasFeature` when the caller supplies an edition.
 */
export interface FeatureMatrixEntry {
  plans: StudioPlan[]
  requires_ee: boolean
  roadmap: boolean
  /** Display name from the catalog (`plan-features` `name`). */
  name: string
}

export const FEATURE_MATRIX: Record<string, FeatureMatrixEntry> = (() => {
  const matrix: Record<string, FeatureMatrixEntry> = {}
  for (const row of Object.values(planFeatures)) {
    if (row.type !== 'feature') continue
    matrix[row.key] = {
      plans: PLAN_SLUGS.filter(plan => parseBoolValue(valueForPlan(row, plan))),
      requires_ee: parseBoolValue(row.requires_ee),
      roadmap: parseBoolValue(row.roadmap ?? 'false'),
      name: row.name,
    }
  }
  return matrix
})()

/**
 * Numeric plan limits per plan. Derived from plan-features rows with
 * `type: 'limit'`. `"unlimited"` in content becomes `Infinity`.
 *
 * `requires_ee` for a limit means: in Community Edition, callers
 * should treat the limit as 0 regardless of the community_value
 * (because the underlying feature cannot function without the bridge).
 * `getPlanLimit` applies this gate when an edition is supplied.
 */
export interface LimitMatrixEntry {
  values: Record<StudioPlan, number>
  requires_ee: boolean
  /** See `applyTrialCap`. */
  trialCap?: { plan: StudioPlan, origins: 'migrate' | 'all' }
}

function parseTrialCap(row: PlanFeatureContent): LimitMatrixEntry['trialCap'] {
  const plan = row.trial_cap_plan as StudioPlan | undefined
  if (!plan || !PLAN_SLUGS.includes(plan)) return undefined
  return { plan, origins: row.trial_cap_origins === 'all' ? 'all' : 'migrate' }
}

export const PLAN_LIMITS: Record<string, LimitMatrixEntry> = (() => {
  const limits: Record<string, LimitMatrixEntry> = {}
  for (const row of Object.values(planFeatures)) {
    if (row.type !== 'limit') continue
    limits[row.key] = {
      values: {
        community: parseLimitValue(row.community_value),
        free: parseLimitValue(row.free_value),
        starter: parseLimitValue(row.starter_value),
        pro: parseLimitValue(row.pro_value),
        enterprise: parseLimitValue(row.enterprise_value),
      },
      requires_ee: parseBoolValue(row.requires_ee),
      trialCap: parseTrialCap(row),
    }
  }
  return limits
})()

/**
 * Where a trial came from. `migrate` = started from a Migrate order
 * (the webhook records it as `plugin_metadata.trial_origin`).
 */
export type TrialOrigin = 'migrate' | 'standard'

export interface TrialContext {
  /** The workspace is in an active trial (`trial_active`). */
  trialing: boolean
  origin: TrialOrigin
}

/**
 * The allowance a trialing workspace actually gets for a limit.
 *
 * Metered usage during a trial is never billed, so a limit whose catalog
 * row sets `trial_cap_plan` is held at that plan's value for the length
 * of the trial — every Pro feature stays on, only the included credits
 * wait for the first payment. `trial_cap_origins` picks which trials:
 * `migrate` (today) or `all` (one content change). Outside a trial, or
 * for an origin the row does not cover, the limit is returned as is.
 * The cap never raises a limit.
 */
export function applyTrialCap(limit: number, limitKey: string, trial: TrialContext | null | undefined): number {
  const plan = trialCapPlan(limitKey, trial)
  return plan ? Math.min(limit, PLAN_LIMITS[limitKey]!.values[plan]) : limit
}

/**
 * The plan a trial is capped to for this limit, or null when no cap
 * applies. Per-message ceilings follow it too (a capped Pro trial settles
 * at Starter's per-message ceiling, not Pro's).
 */
export function trialCapPlan(limitKey: string, trial: TrialContext | null | undefined): StudioPlan | null {
  const cap = PLAN_LIMITS[limitKey]?.trialCap
  if (!cap || !trial?.trialing) return null
  if (cap.origins === 'migrate' && trial.origin !== 'migrate') return null
  return cap.plan
}

/**
 * Overage pricing for limits that allow paid overflow. Derived from
 * plan-features limit rows that carry `overage_price` +
 * `overage_settings_key`.
 *
 * `settingsKey` matches the JSONB key inside `workspaces.overage_settings`
 * — changing it in content has to be coordinated with an app migration.
 */
export const OVERAGE_PRICING: Record<string, { price: number, unit: string, settingsKey: string }> = (() => {
  const pricing: Record<string, { price: number, unit: string, settingsKey: string }> = {}
  for (const row of Object.values(planFeatures)) {
    if (row.type !== 'limit') continue
    if (typeof row.overage_price !== 'number') continue
    if (!row.overage_settings_key) continue
    pricing[row.key] = {
      price: row.overage_price,
      unit: row.overage_unit ?? 'unit',
      settingsKey: row.overage_settings_key,
    }
  }
  return pricing
})()

/** Valid overage settings keys — matches OVERAGE_PRICING values. */
export const OVERAGE_SETTINGS_KEYS = Object.values(OVERAGE_PRICING).map(p => p.settingsKey)

/** `mailto:` address the enterprise CTA button links to. */
export const ENTERPRISE_CONTACT_EMAIL = 'info@contentrain.io'

// ─── Normalisation + lookups (unchanged public API) ───

/**
 * Normalize legacy plan names to current plan types.
 * Backward compatibility: business→pro, team→pro.
 * Default (no plan) → 'free'.
 */
export function normalizePlan(plan: StudioPlan | string | null | undefined): StudioPlan {
  if (!plan) return 'free'

  const legacy: Record<string, StudioPlan> = {
    business: 'pro',
    team: 'pro',
  }

  const normalized = legacy[plan] ?? plan
  if ((PLAN_SLUGS as readonly string[]).includes(normalized)) {
    return normalized as StudioPlan
  }
  return 'free'
}

export interface HasFeatureOptions {
  /**
   * Runtime edition. Defaults to `'ee'` for backward compatibility with
   * existing call sites in the managed service. Community Edition code
   * paths must pass `'agpl'` so that `requires_ee` features are
   * force-disabled.
   */
  edition?: Edition
}

/**
 * Returns true when the given plan tier grants the given feature AND
 * the edition supports it.
 *
 * Gating rule: `plans.includes(plan) AND (!requires_ee OR edition === 'ee')`.
 * Roadmap features are still reported as "granted" so UI can render
 * their "Coming Soon" state; enforcement call sites should cross-check
 * the `roadmap` flag via `FEATURE_MATRIX[key].roadmap`.
 */
export function hasFeatureForPlan(
  plan: StudioPlan | string | null | undefined,
  feature: string,
  options: HasFeatureOptions = {},
): boolean {
  const entry = FEATURE_MATRIX[feature]
  if (!entry) return false
  if (entry.requires_ee && options.edition === 'agpl') return false
  return entry.plans.includes(normalizePlan(plan))
}

export function getPlanLimitForPlan(
  plan: StudioPlan | string | null | undefined,
  limit: string,
  options: HasFeatureOptions = {},
): number {
  const entry = PLAN_LIMITS[limit]
  if (!entry) return 0
  if (entry.requires_ee && options.edition === 'agpl') return 0
  return entry.values[normalizePlan(plan)] ?? 0
}

// ─── UI helpers (unchanged) ───

function formatLimit(value: number): string {
  if (value === Infinity) return 'unlimited'
  if (value >= 1000) return `${(value / 1000).toFixed(0).replace(/\.0$/, '')}K`
  return String(value)
}

function formatStorage(gb: number): string {
  if (gb === Infinity) return 'unlimited'
  return `${gb}GB`
}

function formatFileSize(mb: number): string {
  return `${mb}MB`
}

/**
 * Build interpolation params for a given plan.
 * Use with t() / agentMessage() / agentPrompt() / errorMessage().
 */
export function getPlanParams(plan: StudioPlan | string | null | undefined): Record<string, string | number> {
  const p = normalizePlan(plan)
  const pricing = PLAN_PRICING[p]

  function limit(key: string): number {
    return PLAN_LIMITS[key]?.values[p] ?? 0
  }

  function limitOrUnlimited(key: string): string | number {
    const v = limit(key)
    return v === Infinity ? 'unlimited' : v
  }

  return {
    plan: pricing.name,
    price: `$${pricing.priceMonthly}`,
    seatsIncluded: pricing.seatsIncluded,
    aiMessages: formatLimit(limit('ai.messages_per_month')),
    seats: limitOrUnlimited('team.members'),
    cdnBandwidth: formatStorage(limit('cdn.bandwidth_gb')),
    cdnKeys: limitOrUnlimited('cdn.api_keys'),
    mediaStorage: formatStorage(limit('media.storage_gb')),
    maxFileSize: formatFileSize(limit('media.max_file_size_mb')),
    mediaVariants: limitOrUnlimited('media.variants_per_field'),
    formModels: limitOrUnlimited('forms.models'),
    formSubmissions: formatLimit(limit('forms.submissions_per_month')),
    commentModels: limitOrUnlimited('comments.models'),
    commentsPerMonth: formatLimit(limit('comments.per_month')),
    conversationKeys: limitOrUnlimited('api.conversation_keys'),
    apiMessages: formatLimit(limit('api.messages_per_month')),
    webhookEndpoints: limitOrUnlimited('api.webhooks'),
    mcpKeys: limitOrUnlimited('api.mcp_keys'),
    mcpCalls: formatLimit(limit('api.mcp_calls_per_month')),
  }
}

/**
 * Get the next plan tier for upgrade suggestions.
 * community → starter, free → starter, starter → pro, pro → enterprise,
 * enterprise → enterprise. Community is treated as pre-free for upgrade
 * suggestions even though it is edition-specific; the managed upgrade
 * path is a separate conversation from edition switching.
 */
export function getNextPlan(plan: StudioPlan | string | null | undefined): StudioPlan {
  const p = normalizePlan(plan)
  if (p === 'community') return 'starter'
  if (p === 'free') return 'starter'
  if (p === 'starter') return 'pro'
  if (p === 'pro') return 'enterprise'
  return 'enterprise'
}

/**
 * Build upgrade comparison params: current plan values + target plan values (prefixed with "to").
 * Useful for upgrade strings that compare two plans side by side.
 * If toPlan is omitted, uses the next tier automatically.
 */
export function getUpgradeParams(
  fromPlan: StudioPlan | string | null | undefined,
  toPlan?: StudioPlan | string | null | undefined,
): Record<string, string | number> {
  const from = getPlanParams(fromPlan)
  const to = getPlanParams(toPlan ?? getNextPlan(fromPlan))
  const prefixed: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(to)) {
    prefixed[`to${k.charAt(0).toUpperCase()}${k.slice(1)}`] = v
  }
  return { ...from, ...prefixed }
}

// ─── Plan claims in user- and agent-facing text ───
//
// Text that says which plans carry a feature ("available on all plans",
// "BYOA on Pro and Enterprise") goes stale whenever the catalog moves a
// feature. These build that wording from the catalog instead, so the text
// can never promise what the plan does not grant (BG-1 P1-14).

/** The plans a workspace can buy, lowest first. */
const SOLD_PLANS: StudioPlan[] = ['starter', 'pro', 'enterprise']

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** "Pro and Enterprise" / "every paid plan" — the sold plans that grant `feature`. */
export function plansWithFeatureLabel(feature: string): string {
  const entry = FEATURE_MATRIX[feature]
  const plans = entry ? SOLD_PLANS.filter(plan => entry.plans.includes(plan)) : []
  if (plans.length === SOLD_PLANS.length) return 'every paid plan'
  if (plans.length === 0) return 'no current plan'
  return joinNames(plans.map(plan => PLAN_PRICING[plan].name))
}

/**
 * `{plans:<feature key>}` for every catalog feature, e.g.
 * `{plans:ai.byoa}` → "Pro and Enterprise". Merged into every error and
 * agent string, so any text can state availability without hard-coding it.
 */
export function featurePlanParams(): Record<string, string> {
  const params: Record<string, string> = {}
  for (const key of Object.keys(FEATURE_MATRIX)) params[`plans:${key}`] = plansWithFeatureLabel(key)
  return params
}

/** Shipped features some paid plans lack — the only real difference beyond limits. */
function gatedFeatures(): Array<[string, FeatureMatrixEntry]> {
  return Object.entries(FEATURE_MATRIX).filter(([, e]) => {
    if (e.roadmap) return false
    const onSold = SOLD_PLANS.filter(plan => e.plans.includes(plan)).length
    return onSold > 0 && onSold < SOLD_PLANS.length
  })
}

/** "Bring Your Own API Key (Pro and Enterprise), Conversation API (Pro and Enterprise), …" */
export function planGatedFeaturesLabel(): string {
  return gatedFeatures().map(([key, e]) => `${e.name} (${plansWithFeatureLabel(key)})`).join(', ')
}

/** Shipped features `plan` does not include, by catalog name; empty when it has them all. */
export function featuresMissingOnPlan(plan: StudioPlan | string | null | undefined): string[] {
  const p = normalizePlan(plan)
  return gatedFeatures().filter(([, e]) => !e.plans.includes(p)).map(([, e]) => e.name)
}

/** Shipped plan-gated features `plan` does include, by catalog name. */
export function gatedFeaturesOnPlan(plan: StudioPlan | string | null | undefined): string[] {
  const p = normalizePlan(plan)
  return gatedFeatures().filter(([, e]) => e.plans.includes(p)).map(([, e]) => e.name)
}
