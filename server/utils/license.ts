/**
 * License & feature flag system.
 *
 * Core (AGPL) checks workspace.plan to gate ee/ features.
 * Feature matrix defines which plan unlocks which capability.
 *
 * Plans: free → pro ($9/mo) → team ($29/mo + seats) → enterprise (custom)
 * DB stores 'team' but code normalizes to 'business' for backward compat.
 *
 * Pricing model: base plan (feature unlock) + usage-based overage.
 * Plan limits define "included" amounts. Overage billed separately (Stripe metering).
 *
 * Usage:
 *   const plan = getWorkspacePlan(workspace)
 *   if (hasFeature(plan, 'roles.reviewer')) { ... }
 *
 * Design: hasFeature() is the ONLY way to check features.
 * Never hardcode plan === 'pro' checks in route handlers.
 */

export type Plan = 'free' | 'pro' | 'business' | 'enterprise'

const FEATURE_MATRIX: Record<string, Plan[]> = {
  // Roles & permissions
  'roles.reviewer': ['pro', 'business', 'enterprise'],
  'roles.viewer': ['pro', 'business', 'enterprise'],
  'roles.specific_models': ['business', 'enterprise'],

  // AI
  'ai.byoa': ['free', 'pro', 'business', 'enterprise'],
  'ai.studio_key': ['free', 'pro', 'business', 'enterprise'],

  // Workflow
  'workflow.review': ['pro', 'business', 'enterprise'],

  // CDN
  'cdn.delivery': ['pro', 'business', 'enterprise'],
  'cdn.preview_branch': ['business', 'enterprise'],
  'cdn.custom_domain': ['enterprise'],

  // Media
  'media.upload': ['pro', 'business', 'enterprise'],
  'media.library': ['pro', 'business', 'enterprise'],
  'media.custom_variants': ['business', 'enterprise'],

  // Forms
  'forms.enabled': ['free', 'pro', 'business', 'enterprise'],
  'forms.file_upload': ['pro', 'business', 'enterprise'],
  'forms.captcha': ['pro', 'business', 'enterprise'],
  'forms.notifications': ['pro', 'business', 'enterprise'],
  'forms.webhook_notification': ['business', 'enterprise'],
  'forms.spam_filter': ['business', 'enterprise'],
  'forms.auto_approve': ['pro', 'business', 'enterprise'],

  // API (Team+)
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
  // Normalize 'team' → 'business' (DB stores 'team', code uses 'business')
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
  const p = (plan ?? 'free') as Plan
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
 * Numeric limits per plan. Represents "included" amounts.
 * Usage beyond these limits = overage billing (Stripe metering).
 */
const PLAN_LIMITS: Record<string, Record<Plan, number>> = {
  // Workspace & team
  'workspace.count': { free: Infinity, pro: Infinity, business: Infinity, enterprise: Infinity },
  'team.members': { free: 2, pro: 10, business: 50, enterprise: Infinity },

  // AI messages (included per month, BYOA unlimited on all plans)
  'ai.messages_per_month': { free: 50, pro: 500, business: 2_000, enterprise: Infinity },

  // CDN (included, overage billed)
  'cdn.api_keys': { free: 0, pro: 5, business: Infinity, enterprise: Infinity },
  'cdn.bandwidth_gb': { free: 0, pro: 10, business: 50, enterprise: Infinity },

  // Media (included, overage billed)
  'media.storage_gb': { free: 0, pro: 2, business: 10, enterprise: Infinity },
  'media.max_file_size_mb': { free: 0, pro: 10, business: 50, enterprise: 100 },
  'media.variants_per_field': { free: 0, pro: 4, business: 10, enterprise: Infinity },

  // Forms (included, overage billed)
  'forms.models': { free: 1, pro: 5, business: Infinity, enterprise: Infinity },
  'forms.submissions_per_month': { free: 50, pro: 500, business: 5_000, enterprise: Infinity },

  // API (Team+, overage billed)
  'api.conversation_keys': { free: 0, pro: 0, business: 5, enterprise: Infinity },
  'api.messages_per_month': { free: 0, pro: 0, business: 1_000, enterprise: Infinity },
  'api.webhooks': { free: 0, pro: 0, business: 10, enterprise: Infinity },
}

export function getPlanLimit(plan: Plan | string | null | undefined, limit: string): number {
  const p = (plan ?? 'free') as Plan
  return PLAN_LIMITS[limit]?.[p] ?? 0
}
