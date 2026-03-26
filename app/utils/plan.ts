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
  'roles.specific_models': ['business', 'enterprise'],
  'ai.byoa': ['free', 'pro', 'business', 'enterprise'],
  'ai.studio_key': ['free', 'pro', 'business', 'enterprise'],
  'workflow.review': ['pro', 'business', 'enterprise'],
  'cdn.delivery': ['pro', 'business', 'enterprise'],
  'cdn.preview_branch': ['business', 'enterprise'],
  'cdn.custom_domain': ['enterprise'],
  'media.upload': ['pro', 'business', 'enterprise'],
  'media.library': ['pro', 'business', 'enterprise'],
  'media.custom_variants': ['business', 'enterprise'],
  'forms.enabled': ['free', 'pro', 'business', 'enterprise'],
  'forms.file_upload': ['pro', 'business', 'enterprise'],
  'forms.captcha': ['pro', 'business', 'enterprise'],
  'forms.notifications': ['pro', 'business', 'enterprise'],
  'forms.auto_approve': ['pro', 'business', 'enterprise'],
  'api.conversation': ['business', 'enterprise'],
  'api.rest': ['business', 'enterprise'],
  'api.webhooks_outbound': ['business', 'enterprise'],
  'sso.saml': ['enterprise'],
  'sso.oidc': ['enterprise'],
  'branding.white_label': ['enterprise'],
}

export function hasFeature(plan: string | null | undefined, feature: string): boolean {
  const p = (plan === 'team' ? 'business' : plan ?? 'free') as Plan
  return FEATURE_MATRIX[feature]?.includes(p) ?? false
}
