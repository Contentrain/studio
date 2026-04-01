/**
 * Plan & feature flag system — single source of truth.
 *
 * Plan definitions live in Contentrain models (plans + plan-features).
 * This file provides the runtime lookup tables generated from that content.
 *
 * Plans: starter ($9/mo), pro ($29/mo + $9/seat), enterprise (custom)
 * Trial is a state (trial_ends_at on workspace), not a plan.
 * All features are available on all plans — difference is usage limits.
 * Enterprise-only: SSO, white-label, custom CDN domain.
 */

export type StudioPlan = 'starter' | 'pro' | 'enterprise'

/**
 * Feature matrix: which plans have access to each feature.
 * Generated from Contentrain plan-features model (type: "feature").
 */
export const FEATURE_MATRIX: Record<string, StudioPlan[]> = {
  // AI
  'ai.agent': ['starter', 'pro', 'enterprise'],
  'ai.byoa': ['starter', 'pro', 'enterprise'],
  'ai.studio_key': ['starter', 'pro', 'enterprise'],

  // CDN
  'cdn.delivery': ['starter', 'pro', 'enterprise'],
  'cdn.preview_branch': ['pro', 'enterprise'],
  'cdn.custom_domain': ['enterprise'],
  'cdn.metering': ['starter', 'pro', 'enterprise'],

  // Media
  'media.upload': ['starter', 'pro', 'enterprise'],
  'media.library': ['starter', 'pro', 'enterprise'],
  'media.custom_variants': ['pro', 'enterprise'],

  // Forms
  'forms.enabled': ['starter', 'pro', 'enterprise'],
  'forms.file_upload': ['starter', 'pro', 'enterprise'],
  'forms.captcha': ['starter', 'pro', 'enterprise'],
  'forms.notifications': ['starter', 'pro', 'enterprise'],
  'forms.webhook_notification': ['starter', 'pro', 'enterprise'],
  'forms.spam_filter': ['pro', 'enterprise'],
  'forms.auto_approve': ['starter', 'pro', 'enterprise'],

  // Workflow
  'workflow.review': ['starter', 'pro', 'enterprise'],

  // Roles
  'roles.reviewer': ['starter', 'pro', 'enterprise'],
  'roles.viewer': ['starter', 'pro', 'enterprise'],
  'roles.specific_models': ['pro', 'enterprise'],

  // API
  'api.conversation': ['starter', 'pro', 'enterprise'],
  'api.rest': ['starter', 'pro', 'enterprise'],
  'api.custom_instructions': ['starter', 'pro', 'enterprise'],
  'api.webhooks_outbound': ['starter', 'pro', 'enterprise'],

  // Enterprise-only
  'sso.saml': ['enterprise'],
  'sso.oidc': ['enterprise'],
  'branding.white_label': ['enterprise'],
}

/**
 * Plan limits: numeric quotas per plan.
 * Generated from Contentrain plan-features model (type: "limit").
 * Infinity = unlimited.
 */
export const PLAN_LIMITS: Record<string, Record<StudioPlan, number>> = {
  'ai.messages_per_month': { starter: 50, pro: 500, enterprise: Infinity },
  'team.members': { starter: 3, pro: 25, enterprise: Infinity },
  'cdn.api_keys': { starter: 3, pro: 10, enterprise: Infinity },
  'cdn.bandwidth_gb': { starter: 2, pro: 20, enterprise: Infinity },
  'media.storage_gb': { starter: 1, pro: 5, enterprise: 100 },
  'media.max_file_size_mb': { starter: 5, pro: 50, enterprise: 100 },
  'media.variants_per_field': { starter: 4, pro: 10, enterprise: Infinity },
  'forms.models': { starter: 1, pro: 5, enterprise: Infinity },
  'forms.submissions_per_month': { starter: 100, pro: 1_000, enterprise: Infinity },
  'api.conversation_keys': { starter: 1, pro: 5, enterprise: Infinity },
  'api.messages_per_month': { starter: 100, pro: 1_000, enterprise: Infinity },
  'api.webhooks': { starter: 3, pro: 10, enterprise: Infinity },
}

/**
 * Normalize legacy plan names to current plan types.
 * Backward compatibility: free→starter, business→pro, team→pro.
 */
export function normalizePlan(plan: StudioPlan | string | null | undefined): StudioPlan {
  if (!plan) return 'starter'

  // Legacy plan name mappings
  const legacy: Record<string, StudioPlan> = {
    free: 'starter',
    business: 'pro',
    team: 'pro',
  }

  const normalized = legacy[plan] ?? plan
  if (['starter', 'pro', 'enterprise'].includes(normalized)) {
    return normalized as StudioPlan
  }
  return 'starter'
}

export function hasFeatureForPlan(plan: StudioPlan | string | null | undefined, feature: string): boolean {
  return FEATURE_MATRIX[feature]?.includes(normalizePlan(plan)) ?? false
}

export function getPlanLimitForPlan(plan: StudioPlan | string | null | undefined, limit: string): number {
  return PLAN_LIMITS[limit]?.[normalizePlan(plan)] ?? 0
}

/**
 * Plan pricing: single source of truth for prices.
 * Matches Contentrain plans model (plans/en.json).
 */
export const PLAN_PRICING: Record<StudioPlan, { priceMonthly: number, pricePerSeat: number, seatsIncluded: number, name: string }> = {
  starter: { priceMonthly: 9, pricePerSeat: 0, seatsIncluded: 3, name: 'Starter' },
  pro: { priceMonthly: 29, pricePerSeat: 9, seatsIncluded: 10, name: 'Pro' },
  enterprise: { priceMonthly: 0, pricePerSeat: 0, seatsIncluded: 0, name: 'Enterprise' },
}

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
 *
 * Returns all pricing + limit values so dictionary strings
 * can use {price}, {aiMessages}, {seats}, etc. instead of hardcoded values.
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
    pricePerSeat: `$${pricing.pricePerSeat}`,
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
  }
}

/**
 * Get the next plan tier for upgrade suggestions.
 * starter → pro, pro → enterprise, enterprise → enterprise.
 */
export function getNextPlan(plan: StudioPlan | string | null | undefined): StudioPlan {
  const p = normalizePlan(plan)
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
