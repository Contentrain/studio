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

export type StudioPlan = 'free' | 'starter' | 'pro' | 'enterprise'

const PLAN_SLUGS: readonly StudioPlan[] = ['free', 'starter', 'pro', 'enterprise']

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
  free_value: string
  starter_value: string
  pro_value: string
  enterprise_value: string
  overage_price?: number
  overage_unit?: string
  overage_settings_key?: string
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
 * Feature matrix: which plans grant each feature flag. Derived from
 * plan-features rows with `type: 'feature'`.
 *
 * Free is naturally absent from every row because `free_value` is
 * always `"false"` for features in content (see the invariant in the
 * module docstring).
 */
export const FEATURE_MATRIX: Record<string, StudioPlan[]> = (() => {
  const matrix: Record<string, StudioPlan[]> = {}
  for (const row of Object.values(planFeatures)) {
    if (row.type !== 'feature') continue
    const grantedPlans = PLAN_SLUGS.filter(plan => parseBoolValue(valueForPlan(row, plan)))
    matrix[row.key] = grantedPlans
  }
  return matrix
})()

/**
 * Numeric plan limits per plan. Derived from plan-features rows with
 * `type: 'limit'`. `"unlimited"` in content becomes `Infinity`.
 *
 * Free is zero across the board except `team.members` (the owner seat).
 */
export const PLAN_LIMITS: Record<string, Record<StudioPlan, number>> = (() => {
  const limits: Record<string, Record<StudioPlan, number>> = {}
  for (const row of Object.values(planFeatures)) {
    if (row.type !== 'limit') continue
    limits[row.key] = {
      free: parseLimitValue(row.free_value),
      starter: parseLimitValue(row.starter_value),
      pro: parseLimitValue(row.pro_value),
      enterprise: parseLimitValue(row.enterprise_value),
    }
  }
  return limits
})()

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
export const ENTERPRISE_CONTACT_EMAIL = 'sales@contentrain.io'

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

export function hasFeatureForPlan(plan: StudioPlan | string | null | undefined, feature: string): boolean {
  return FEATURE_MATRIX[feature]?.includes(normalizePlan(plan)) ?? false
}

export function getPlanLimitForPlan(plan: StudioPlan | string | null | undefined, limit: string): number {
  return PLAN_LIMITS[limit]?.[normalizePlan(plan)] ?? 0
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
    return PLAN_LIMITS[key]?.[p] ?? 0
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
    conversationKeys: limitOrUnlimited('api.conversation_keys'),
    apiMessages: formatLimit(limit('api.messages_per_month')),
    webhookEndpoints: limitOrUnlimited('api.webhooks'),
    mcpKeys: limitOrUnlimited('api.mcp_keys'),
    mcpCalls: formatLimit(limit('api.mcp_calls_per_month')),
  }
}

/**
 * Get the next plan tier for upgrade suggestions.
 * free → starter, starter → pro, pro → enterprise, enterprise → enterprise.
 */
export function getNextPlan(plan: StudioPlan | string | null | undefined): StudioPlan {
  const p = normalizePlan(plan)
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
