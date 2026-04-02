/**
 * Plan & feature flag system — single source of truth.
 *
 * Plan definitions live in Contentrain models (plans + plan-features).
 * This file provides the runtime lookup tables generated from that content.
 *
 * Plans: free ($0), starter ($9/mo), pro ($29/mo + $9/seat), enterprise (custom)
 * Free = personal workspace default (no Git, no projects, demo only).
 * Paid plans require Stripe subscription (trial_period_days=14 on checkout).
 * Enterprise-only: SSO, white-label, custom CDN domain.
 */

export type StudioPlan = 'free' | 'starter' | 'pro' | 'enterprise'

/**
 * Feature matrix: which plans have access to each feature.
 * Generated from Contentrain plan-features model (type: "feature").
 *
 * Free plan ($0): demo-only landing zone. Can browse the dashboard and
 * use the AI agent with studio key (10 msg/mo) but cannot connect repos,
 * create projects, use BYOA, CDN, forms, or any API features.
 * Upgrade trigger: "Connect Repository" → plan selection → Stripe Checkout.
 *
 * Paid plans (starter/pro): full platform access, differentiated by
 * numeric PLAN_LIMITS (message quotas, storage, seats, etc.).
 *
 * Enterprise: everything + SSO, white-label, custom CDN domain.
 *
 * NOTE: ee/ features (webhooks, conversation API, AI keys, CDN, media
 * processing) require the enterprise bridge to be loaded. If ee/ is absent,
 * routes return 403 regardless of plan — graceful degradation.
 */
export const FEATURE_MATRIX: Record<string, StudioPlan[]> = {
  // AI — free gets studio key only (10 msg/mo), BYOA requires paid plan
  'ai.agent': ['free', 'starter', 'pro', 'enterprise'],
  'ai.byoa': ['starter', 'pro', 'enterprise'],
  'ai.studio_key': ['starter', 'pro', 'enterprise'],

  // CDN — paid plans only (ee/ provides Cloudflare R2 implementation)
  'cdn.delivery': ['starter', 'pro', 'enterprise'],
  'cdn.preview_branch': ['pro', 'enterprise'],
  'cdn.custom_domain': ['enterprise'],
  'cdn.metering': ['starter', 'pro', 'enterprise'],

  // Media — free can browse library only, upload requires paid plan
  'media.upload': ['starter', 'pro', 'enterprise'],
  'media.library': ['free', 'starter', 'pro', 'enterprise'],
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

  // Git & Projects (paywall boundary)
  'git.connect': ['starter', 'pro', 'enterprise'],
  'projects.create': ['starter', 'pro', 'enterprise'],

  // Enterprise-only
  'sso.saml': ['enterprise'],
  'sso.oidc': ['enterprise'],
  'branding.white_label': ['enterprise'],
}

/**
 * Plan limits: numeric quotas per plan.
 * Generated from Contentrain plan-features model (type: "limit").
 * Infinity = unlimited. Free plan has severe limits — upgrade trigger.
 */
export const PLAN_LIMITS: Record<string, Record<StudioPlan, number>> = {
  'ai.messages_per_month': { free: 10, starter: 50, pro: 500, enterprise: Infinity },
  'team.members': { free: 1, starter: 3, pro: 25, enterprise: Infinity },
  'cdn.api_keys': { free: 0, starter: 3, pro: 10, enterprise: Infinity },
  'cdn.bandwidth_gb': { free: 0, starter: 2, pro: 20, enterprise: Infinity },
  'media.storage_gb': { free: 0.2, starter: 1, pro: 5, enterprise: 100 },
  'media.max_file_size_mb': { free: 2, starter: 5, pro: 50, enterprise: 100 },
  'media.variants_per_field': { free: 2, starter: 4, pro: 10, enterprise: Infinity },
  'forms.models': { free: 0, starter: 1, pro: 5, enterprise: Infinity },
  'forms.submissions_per_month': { free: 0, starter: 100, pro: 1_000, enterprise: Infinity },
  'api.conversation_keys': { free: 0, starter: 1, pro: 5, enterprise: Infinity },
  'api.messages_per_month': { free: 0, starter: 100, pro: 1_000, enterprise: Infinity },
  'api.webhooks': { free: 0, starter: 3, pro: 10, enterprise: Infinity },
}

/**
 * Normalize legacy plan names to current plan types.
 * Backward compatibility: business→pro, team→pro.
 * Default (no plan) → 'free'.
 */
export function normalizePlan(plan: StudioPlan | string | null | undefined): StudioPlan {
  if (!plan) return 'free'

  // Legacy plan name mappings
  const legacy: Record<string, StudioPlan> = {
    business: 'pro',
    team: 'pro',
  }

  const normalized = legacy[plan] ?? plan
  if (['free', 'starter', 'pro', 'enterprise'].includes(normalized)) {
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

/**
 * Plan pricing: single source of truth for prices.
 * Matches Contentrain plans model (plans/en.json).
 */
export const PLAN_PRICING: Record<StudioPlan, { priceMonthly: number, pricePerSeat: number, seatsIncluded: number, name: string }> = {
  free: { priceMonthly: 0, pricePerSeat: 0, seatsIncluded: 1, name: 'Free' },
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
