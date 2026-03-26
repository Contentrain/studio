/**
 * License & feature flag system.
 *
 * Plans: free → pro ($12/mo) → team ($39/mo + seats) → enterprise (custom)
 * Revenue model: platform fee (low) + AI credits + usage overage + enterprise license
 *
 * DB stores 'team' but code normalizes to 'business' for backward compat.
 * See .internal/PRICING-STRATEGY.md for full pricing rationale.
 *
 * Usage:
 *   const plan = getWorkspacePlan(workspace)
 *   if (hasFeature(plan, 'cdn.delivery')) { ... }
 *
 * Design: hasFeature() is the ONLY way to check features.
 * Never hardcode plan checks in route handlers.
 */

export type Plan = 'free' | 'pro' | 'business' | 'enterprise'

const FEATURE_MATRIX: Record<string, Plan[]> = {
  // AI — available on ALL plans (BYOA unlimited, studio-hosted = credit-based)
  'ai.agent': ['free', 'pro', 'business', 'enterprise'],
  'ai.byoa': ['free', 'pro', 'business', 'enterprise'],

  // Forms — free gets 1 form (CDN-independent)
  'forms.enabled': ['free', 'pro', 'business', 'enterprise'],
  'forms.file_upload': ['pro', 'business', 'enterprise'],
  'forms.captcha': ['pro', 'business', 'enterprise'],
  'forms.notifications': ['pro', 'business', 'enterprise'],
  'forms.webhook_notification': ['business', 'enterprise'],
  'forms.spam_filter': ['business', 'enterprise'],
  'forms.auto_approve': ['pro', 'business', 'enterprise'],

  // CDN — Pro+
  'cdn.delivery': ['pro', 'business', 'enterprise'],
  'cdn.preview_branch': ['business', 'enterprise'],
  'cdn.custom_domain': ['enterprise'],

  // Media — Pro+
  'media.upload': ['pro', 'business', 'enterprise'],
  'media.library': ['pro', 'business', 'enterprise'],
  'media.custom_variants': ['business', 'enterprise'],

  // Workflow — Pro+
  'workflow.review': ['pro', 'business', 'enterprise'],

  // Roles — Pro+ (basic), Team+ (advanced)
  'roles.reviewer': ['pro', 'business', 'enterprise'],
  'roles.viewer': ['pro', 'business', 'enterprise'],
  'roles.specific_models': ['business', 'enterprise'],

  // API — Team+
  'api.conversation': ['business', 'enterprise'],
  'api.rest': ['business', 'enterprise'],
  'api.custom_instructions': ['business', 'enterprise'],
  'api.webhooks_outbound': ['business', 'enterprise'],

  // Enterprise
  'sso.saml': ['enterprise'],
  'sso.oidc': ['enterprise'],
  'branding.white_label': ['enterprise'],
}

/**
 * Extract plan from workspace row. Defaults to 'free'.
 */
export function getWorkspacePlan(workspace: { plan?: string | null }): Plan {
  const raw = workspace?.plan
  const plan = raw === 'team' ? 'business' : raw
  if (plan && ['free', 'pro', 'business', 'enterprise'].includes(plan)) {
    return plan as Plan
  }
  return 'free'
}

/**
 * Check if a plan includes a specific feature.
 * This is the ONLY function to use for feature gating.
 */
export function hasFeature(plan: Plan | string | null | undefined, feature: string): boolean {
  const p = ((plan === 'team' ? 'business' : plan) ?? 'free') as Plan
  return FEATURE_MATRIX[feature]?.includes(p) ?? false
}

/**
 * Get all features available for a plan.
 */
export function getAvailableFeatures(plan: Plan): string[] {
  return Object.entries(FEATURE_MATRIX)
    .filter(([_, plans]) => plans.includes(plan))
    .map(([feature]) => feature)
}

/**
 * Plan limits — "included" amounts per billing period.
 * Usage beyond = overage billing via Stripe metering.
 * AI credit packs are separate add-ons (not tied to plan limits).
 */
const PLAN_LIMITS: Record<string, Record<Plan, number>> = {
  // Team
  'team.members': { free: 2, pro: 10, business: 50, enterprise: Infinity },

  // AI (included messages per month — BYOA unlimited on all plans)
  'ai.messages_per_month': { free: 100, pro: 500, business: 2_000, enterprise: Infinity },

  // CDN
  'cdn.api_keys': { free: 0, pro: 5, business: Infinity, enterprise: Infinity },
  'cdn.bandwidth_gb': { free: 0, pro: 20, business: 100, enterprise: Infinity },

  // Media
  'media.storage_gb': { free: 0, pro: 5, business: 20, enterprise: Infinity },
  'media.max_file_size_mb': { free: 0, pro: 10, business: 50, enterprise: 100 },
  'media.variants_per_field': { free: 0, pro: 4, business: 10, enterprise: Infinity },

  // Forms
  'forms.models': { free: 1, pro: 5, business: Infinity, enterprise: Infinity },
  'forms.submissions_per_month': { free: 100, pro: 1_000, business: 5_000, enterprise: Infinity },

  // API (Team+)
  'api.conversation_keys': { free: 0, pro: 0, business: 5, enterprise: Infinity },
  'api.messages_per_month': { free: 0, pro: 0, business: 1_000, enterprise: Infinity },
  'api.webhooks': { free: 0, pro: 0, business: 10, enterprise: Infinity },
}

export function getPlanLimit(plan: Plan | string | null | undefined, limit: string): number {
  const p = ((plan === 'team' ? 'business' : plan) ?? 'free') as Plan
  return PLAN_LIMITS[limit]?.[p] ?? 0
}
