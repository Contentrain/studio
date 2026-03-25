/**
 * License & feature flag system.
 *
 * Core (AGPL) checks workspace.plan to gate ee/ features.
 * Feature matrix defines which plan unlocks which capability.
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
  'roles.specific_models': ['pro', 'business', 'enterprise'],

  // AI
  'ai.byoa': ['pro', 'business', 'enterprise'],
  'ai.studio_key': ['pro', 'business', 'enterprise'],

  // Connectors
  'connector.canva': ['pro', 'business', 'enterprise'],
  'connector.figma': ['pro', 'business', 'enterprise'],
  'connector.recraft': ['pro', 'business', 'enterprise'],
  'connector.google_drive': ['business', 'enterprise'],
  'connector.notion': ['business', 'enterprise'],

  // Workflow
  'workflow.review': ['pro', 'business', 'enterprise'],
  'workflow.approval_chains': ['business', 'enterprise'],
  'workflow.scheduled_publish': ['business', 'enterprise'],

  // Team
  'team.audit_log': ['business', 'enterprise'],
  'team.activity_feed': ['business', 'enterprise'],

  // CDN
  'cdn.delivery': ['pro', 'business', 'enterprise'],
  'cdn.preview_branch': ['business', 'enterprise'],
  'cdn.custom_domain': ['enterprise'],
  'cdn.ip_allowlist': ['business', 'enterprise'],

  // Media
  'media.upload': ['pro', 'business', 'enterprise'],
  'media.library': ['pro', 'business', 'enterprise'],
  'media.custom_variants': ['business', 'enterprise'],

  // Enterprise
  'sso.saml': ['enterprise'],
  'sso.oidc': ['enterprise'],
  'branding.white_label': ['enterprise'],
  'api.webhooks_outbound': ['business', 'enterprise'],
  'api.rest': ['business', 'enterprise'],
}

/**
 * Extract plan from workspace row. Defaults to 'free'.
 */
export function getWorkspacePlan(workspace: { plan?: string | null }): Plan {
  const raw = workspace?.plan
  // Normalize 'team' → 'business' (DB schema allows both, code uses 'business')
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
export function hasFeature(plan: Plan, feature: string): boolean {
  return FEATURE_MATRIX[feature]?.includes(plan) ?? false
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
 * Get numeric limit for a plan-gated resource.
 * Returns 0 for features not available on the plan.
 */
const PLAN_LIMITS: Record<string, Record<Plan, number>> = {
  'workspace.count': { free: 1, pro: 3, business: Infinity, enterprise: Infinity },
  'team.members': { free: 2, pro: 10, business: 50, enterprise: Infinity },
  'cdn.api_keys': { free: 0, pro: 3, business: 10, enterprise: Infinity },
  'cdn.requests_per_month': { free: 0, pro: 100_000, business: 1_000_000, enterprise: Infinity },
  'cdn.bandwidth_gb': { free: 0, pro: 10, business: 100, enterprise: Infinity },
  'media.storage_gb': { free: 0, pro: 1, business: 5, enterprise: Infinity },
  'media.max_file_size_mb': { free: 0, pro: 10, business: 50, enterprise: 100 },
  'media.variants_per_field': { free: 0, pro: 4, business: 10, enterprise: Infinity },
}

export function getPlanLimit(plan: Plan, limit: string): number {
  return PLAN_LIMITS[limit]?.[plan] ?? 0
}
