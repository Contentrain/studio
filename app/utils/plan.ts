/**
 * Client-side plan utilities.
 * Mirrors server/utils/license.ts feature matrix for UI gating.
 *
 * IMPORTANT: Client-side checks are for UX only (hide/show UI).
 * Server-side hasFeature() is the authoritative gate.
 */

export type Plan = 'free' | 'pro' | 'business' | 'enterprise'

const FEATURE_MATRIX: Record<string, Plan[]> = {
  'roles.reviewer': ['pro', 'business', 'enterprise'],
  'roles.viewer': ['pro', 'business', 'enterprise'],
  'roles.specific_models': ['pro', 'business', 'enterprise'],
  'ai.byoa': ['pro', 'business', 'enterprise'],
  'ai.studio_key': ['pro', 'business', 'enterprise'],
  'connector.canva': ['pro', 'business', 'enterprise'],
  'connector.figma': ['pro', 'business', 'enterprise'],
  'connector.recraft': ['pro', 'business', 'enterprise'],
  'connector.google_drive': ['business', 'enterprise'],
  'connector.notion': ['business', 'enterprise'],
  'workflow.review': ['pro', 'business', 'enterprise'],
  'workflow.approval_chains': ['business', 'enterprise'],
  'workflow.scheduled_publish': ['business', 'enterprise'],
  'team.audit_log': ['business', 'enterprise'],
  'team.activity_feed': ['business', 'enterprise'],
  'cdn.delivery': ['pro', 'business', 'enterprise'],
  'cdn.preview_branch': ['business', 'enterprise'],
  'cdn.custom_domain': ['enterprise'],
  'cdn.ip_allowlist': ['business', 'enterprise'],
  'sso.saml': ['enterprise'],
  'sso.oidc': ['enterprise'],
  'branding.white_label': ['enterprise'],
  'api.webhooks_outbound': ['business', 'enterprise'],
  'api.rest': ['business', 'enterprise'],
}

export function hasFeature(plan: string | null | undefined, feature: string): boolean {
  const p = (plan ?? 'free') as Plan
  return FEATURE_MATRIX[feature]?.includes(p) ?? false
}
