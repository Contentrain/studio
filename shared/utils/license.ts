export type StudioPlan = 'free' | 'pro' | 'business' | 'enterprise'

export const FEATURE_MATRIX: Record<string, StudioPlan[]> = {
  'ai.agent': ['free', 'pro', 'business', 'enterprise'],
  'ai.byoa': ['pro', 'business', 'enterprise'],
  'ai.studio_key': ['free', 'pro', 'business', 'enterprise'],

  'forms.enabled': ['free', 'pro', 'business', 'enterprise'],
  'forms.file_upload': ['pro', 'business', 'enterprise'],
  'forms.captcha': ['pro', 'business', 'enterprise'],
  'forms.notifications': ['pro', 'business', 'enterprise'],
  'forms.webhook_notification': ['business', 'enterprise'],
  'forms.spam_filter': ['business', 'enterprise'],
  'forms.auto_approve': ['pro', 'business', 'enterprise'],

  'cdn.delivery': ['pro', 'business', 'enterprise'],
  'cdn.preview_branch': ['business', 'enterprise'],
  'cdn.custom_domain': ['enterprise'],
  'cdn.metering': ['business', 'enterprise'],

  'media.upload': ['pro', 'business', 'enterprise'],
  'media.library': ['pro', 'business', 'enterprise'],
  'media.custom_variants': ['business', 'enterprise'],

  'workflow.review': ['pro', 'business', 'enterprise'],

  'roles.reviewer': ['pro', 'business', 'enterprise'],
  'roles.viewer': ['pro', 'business', 'enterprise'],
  'roles.specific_models': ['business', 'enterprise'],

  'api.conversation': ['business', 'enterprise'],
  'api.rest': ['business', 'enterprise'],
  'api.custom_instructions': ['business', 'enterprise'],
  'api.webhooks_outbound': ['business', 'enterprise'],

  'sso.saml': ['enterprise'],
  'sso.oidc': ['enterprise'],
  'branding.white_label': ['enterprise'],
}

export const PLAN_LIMITS: Record<string, Record<StudioPlan, number>> = {
  'workspace.count': { free: 1, pro: 3, business: Infinity, enterprise: Infinity },
  'team.members': { free: 2, pro: 10, business: 50, enterprise: Infinity },
  'ai.messages_per_month': { free: 100, pro: 500, business: 2_000, enterprise: Infinity },
  'cdn.api_keys': { free: 0, pro: 5, business: Infinity, enterprise: Infinity },
  'cdn.bandwidth_gb': { free: 0, pro: 20, business: 100, enterprise: Infinity },
  'media.storage_gb': { free: 0, pro: 5, business: 20, enterprise: Infinity },
  'media.max_file_size_mb': { free: 0, pro: 10, business: 50, enterprise: 100 },
  'media.variants_per_field': { free: 0, pro: 4, business: 10, enterprise: Infinity },
  'forms.models': { free: 1, pro: 5, business: Infinity, enterprise: Infinity },
  'forms.submissions_per_month': { free: 100, pro: 1_000, business: 5_000, enterprise: Infinity },
  'api.conversation_keys': { free: 0, pro: 0, business: 5, enterprise: Infinity },
  'api.messages_per_month': { free: 0, pro: 0, business: 1_000, enterprise: Infinity },
  'api.webhooks': { free: 0, pro: 0, business: 10, enterprise: Infinity },
}

export function normalizePlan(plan: StudioPlan | string | null | undefined): StudioPlan {
  const normalized = plan === 'team' ? 'business' : plan
  if (normalized && ['free', 'pro', 'business', 'enterprise'].includes(normalized)) {
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
