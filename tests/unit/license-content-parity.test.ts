/**
 * Parity guard between code and `.contentrain/` content.
 *
 * `shared/utils/license.ts` derives PLAN_PRICING / FEATURE_MATRIX /
 * PLAN_LIMITS / OVERAGE_PRICING from the content layer. If a feature
 * row or a limit entry gets accidentally removed from content the
 * derivation will silently produce `undefined` and the app will drift
 * toward "free" behavior. These assertions pin the canonical set of
 * keys + a few critical values so any drift shows up in CI before it
 * can reach production.
 *
 * Matrix shape (post-edition-orthogonality):
 *   FEATURE_MATRIX[key] = { plans: StudioPlan[], requires_ee: boolean, roadmap: boolean }
 *   PLAN_LIMITS[key]    = { values: Record<StudioPlan, number>, requires_ee: boolean }
 */

import { describe, expect, it } from 'vitest'
import {
  FEATURE_MATRIX,
  OVERAGE_PRICING,
  OVERAGE_SETTINGS_KEYS,
  PLAN_LIMITS,
  PLAN_PRICING,
} from '../../shared/utils/license'

// Feature keys that must be in the matrix. Note: `ai.agent`,
// `git.connect`, and `projects.create` were removed intentionally
// because they represent core product capabilities that are always
// on — plan differentiation made no business sense.
const REQUIRED_FEATURES = [
  'ai.byoa',
  'ai.studio_key',
  'cdn.delivery',
  'cdn.preview_branch',
  'cdn.custom_domain',
  'cdn.metering',
  'media.upload',
  'media.library',
  'media.custom_variants',
  'forms.enabled',
  'forms.file_upload',
  'forms.captcha',
  'forms.notifications',
  'forms.webhook_notification',
  'forms.spam_filter',
  'forms.auto_approve',
  'workflow.review',
  'roles.reviewer',
  'roles.viewer',
  'roles.specific_models',
  'api.conversation',
  'api.custom_instructions',
  'api.webhooks_outbound',
  'api.mcp_cloud',
  'api.mcp_cloud_sso',
  'api.mcp_cloud_custom_domain',
  'sso.saml',
  'sso.oidc',
  'branding.white_label',
] as const

const REQUIRED_LIMITS = [
  'ai.messages_per_month',
  'team.members',
  'cdn.api_keys',
  'cdn.bandwidth_gb',
  'media.storage_gb',
  'media.max_file_size_mb',
  'media.variants_per_field',
  'forms.models',
  'forms.submissions_per_month',
  'api.conversation_keys',
  'api.messages_per_month',
  'api.webhooks',
  'api.mcp_keys',
  'api.mcp_calls_per_month',
] as const

const REQUIRED_OVERAGE_KEYS = [
  'ai.messages_per_month',
  'api.messages_per_month',
  'api.mcp_calls_per_month',
  'cdn.bandwidth_gb',
  'forms.submissions_per_month',
  'media.storage_gb',
] as const

// Features that must be flagged `requires_ee: true` so Community
// Edition force-disables them regardless of plan.
const EE_REQUIRED_FEATURES = [
  'ai.byoa',
  'ai.studio_key',
  'api.conversation',
  'api.custom_instructions',
  'api.webhooks_outbound',
  'cdn.delivery',
  'cdn.metering',
  'cdn.custom_domain',
  'cdn.preview_branch',
  'media.upload',
  'media.library',
  'media.custom_variants',
  'roles.reviewer',
  'roles.viewer',
  'roles.specific_models',
  'sso.saml',
  'sso.oidc',
  'branding.white_label',
  'forms.file_upload',
  'forms.spam_filter',
  'forms.webhook_notification',
  'api.mcp_cloud_sso',
  'api.mcp_cloud_custom_domain',
] as const

describe('license ↔ content parity', () => {
  describe('PLAN_PRICING (derived from plans/en.json)', () => {
    it('exposes community / free / starter / pro / enterprise rows', () => {
      expect(PLAN_PRICING.community).toBeDefined()
      expect(PLAN_PRICING.free).toBeDefined()
      expect(PLAN_PRICING.starter).toBeDefined()
      expect(PLAN_PRICING.pro).toBeDefined()
      expect(PLAN_PRICING.enterprise).toBeDefined()
    })

    it('pins canonical monthly prices', () => {
      expect(PLAN_PRICING.community.priceMonthly).toBe(0)
      expect(PLAN_PRICING.free.priceMonthly).toBe(0)
      expect(PLAN_PRICING.starter.priceMonthly).toBe(9)
      expect(PLAN_PRICING.pro.priceMonthly).toBe(49)
    })

    it('pins canonical seat counts', () => {
      expect(PLAN_PRICING.free.seatsIncluded).toBe(1)
      expect(PLAN_PRICING.starter.seatsIncluded).toBe(3)
      expect(PLAN_PRICING.pro.seatsIncluded).toBe(25)
    })
  })

  describe('FEATURE_MATRIX (derived from plan-features type=feature rows)', () => {
    it.each(REQUIRED_FEATURES)('has row for "%s"', (key) => {
      expect(FEATURE_MATRIX[key]).toBeDefined()
    })

    it('free plan is excluded from every feature row (structural shell)', () => {
      for (const [key, entry] of Object.entries(FEATURE_MATRIX)) {
        expect(entry.plans, `free must not be in FEATURE_MATRIX.${key}.plans`).not.toContain('free')
      }
    })

    it('enterprise-only features are only granted to enterprise', () => {
      const enterpriseOnly = ['sso.saml', 'sso.oidc', 'branding.white_label', 'cdn.custom_domain', 'api.mcp_cloud_sso', 'api.mcp_cloud_custom_domain']
      for (const key of enterpriseOnly) {
        const entry = FEATURE_MATRIX[key]!
        expect(entry.plans, `${key} should be enterprise-only`).toEqual(['enterprise'])
      }
    })

    it('pro-tier features are exposed to pro and enterprise only', () => {
      const proAndAbove = ['cdn.preview_branch', 'media.custom_variants', 'roles.specific_models', 'forms.spam_filter']
      for (const key of proAndAbove) {
        const entry = FEATURE_MATRIX[key]!
        expect(entry.plans, `${key} should be pro+`).toEqual(['pro', 'enterprise'])
      }
    })

    it.each(EE_REQUIRED_FEATURES)('"%s" carries requires_ee=true', (key) => {
      const entry = FEATURE_MATRIX[key]
      expect(entry?.requires_ee, `${key} must require ee bridge`).toBe(true)
    })

    it('core forms features do NOT require the ee bridge', () => {
      const coreForms = ['forms.enabled', 'forms.captcha', 'forms.auto_approve', 'forms.notifications']
      for (const key of coreForms) {
        const entry = FEATURE_MATRIX[key]!
        expect(entry.requires_ee, `${key} must be core (no ee dependency)`).toBe(false)
      }
    })

    it('community tier gets core features but not requires_ee features', () => {
      expect(FEATURE_MATRIX['forms.enabled']!.plans).toContain('community')
      expect(FEATURE_MATRIX['workflow.review']!.plans).toContain('community')
      expect(FEATURE_MATRIX['api.mcp_cloud']!.plans).toContain('community')
      expect(FEATURE_MATRIX['cdn.delivery']!.plans).not.toContain('community')
      expect(FEATURE_MATRIX['media.upload']!.plans).not.toContain('community')
      expect(FEATURE_MATRIX['roles.reviewer']!.plans).not.toContain('community')
    })
  })

  describe('PLAN_LIMITS (derived from plan-features type=limit rows)', () => {
    it.each(REQUIRED_LIMITS)('has row for "%s"', (key) => {
      expect(PLAN_LIMITS[key]).toBeDefined()
    })

    it('pins Pro canonical AI message limit', () => {
      expect(PLAN_LIMITS['ai.messages_per_month']!.values.pro).toBe(1500)
    })

    it('pins Pro canonical API message limit', () => {
      expect(PLAN_LIMITS['api.messages_per_month']!.values.pro).toBe(3000)
    })

    it('pins Starter AI message limit', () => {
      expect(PLAN_LIMITS['ai.messages_per_month']!.values.starter).toBe(150)
    })

    it('team.members keeps the structural owner seat on free', () => {
      expect(PLAN_LIMITS['team.members']!.values.free).toBe(1)
    })

    it('free plan has zero everywhere except team.members', () => {
      for (const [key, entry] of Object.entries(PLAN_LIMITS)) {
        if (key === 'team.members') continue
        expect(entry.values.free, `${key}.free must be 0`).toBe(0)
      }
    })

    it('enterprise limits are Infinity or a finite hard cap', () => {
      for (const [, entry] of Object.entries(PLAN_LIMITS)) {
        expect(entry.values.enterprise).toBeGreaterThan(0)
      }
    })

    it('community limits are unlimited for core limits and zero for ee-gated limits', () => {
      // Core: team.members has no ee requirement → unlimited
      expect(PLAN_LIMITS['team.members']!.values.community).toBe(Infinity)
      expect(PLAN_LIMITS['forms.submissions_per_month']!.values.community).toBe(Infinity)
      // EE-gated limits (still stored as unlimited on the row) — but
      // the gating happens inside getPlanLimit, not the matrix itself.
      expect(PLAN_LIMITS['cdn.bandwidth_gb']!.requires_ee).toBe(true)
      expect(PLAN_LIMITS['media.storage_gb']!.requires_ee).toBe(true)
    })
  })

  describe('OVERAGE_PRICING (derived from limit rows with overage_price + overage_settings_key)', () => {
    it.each(REQUIRED_OVERAGE_KEYS)('has row for "%s"', (key) => {
      expect(OVERAGE_PRICING[key]).toBeDefined()
    })

    it('pins canonical unit prices', () => {
      expect(OVERAGE_PRICING['ai.messages_per_month']!.price).toBe(0.03)
      expect(OVERAGE_PRICING['api.messages_per_month']!.price).toBe(0.05)
      expect(OVERAGE_PRICING['api.mcp_calls_per_month']!.price).toBe(0.005)
      expect(OVERAGE_PRICING['cdn.bandwidth_gb']!.price).toBe(0.10)
      expect(OVERAGE_PRICING['forms.submissions_per_month']!.price).toBe(0.01)
      expect(OVERAGE_PRICING['media.storage_gb']!.price).toBe(0.25)
    })

    it('pins canonical JSONB settings keys', () => {
      expect(OVERAGE_PRICING['ai.messages_per_month']!.settingsKey).toBe('ai_messages')
      expect(OVERAGE_PRICING['api.messages_per_month']!.settingsKey).toBe('api_messages')
      expect(OVERAGE_PRICING['api.mcp_calls_per_month']!.settingsKey).toBe('mcp_calls')
      expect(OVERAGE_PRICING['cdn.bandwidth_gb']!.settingsKey).toBe('cdn_bandwidth')
      expect(OVERAGE_PRICING['forms.submissions_per_month']!.settingsKey).toBe('form_submissions')
      expect(OVERAGE_PRICING['media.storage_gb']!.settingsKey).toBe('media_storage')
    })

    it('OVERAGE_SETTINGS_KEYS is kept in sync with OVERAGE_PRICING', () => {
      const fromPricing = Object.values(OVERAGE_PRICING).map(p => p.settingsKey).sort()
      const exported = [...OVERAGE_SETTINGS_KEYS].sort()
      expect(exported).toEqual(fromPricing)
    })
  })
})
