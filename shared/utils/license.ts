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
