import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAvailableFeatures, getPlanLimit, getWorkspacePlan, hasFeature } from '../../server/utils/license'

// Mock useRuntimeConfig — simulate Stripe configured (SaaS mode)
vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
  stripe: { secretKey: 'sk_test_mock' },
}))

describe('license utilities', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('normalizes legacy plan names', () => {
    expect(getWorkspacePlan({ plan: 'team' })).toBe('pro')
    expect(getWorkspacePlan({ plan: 'business' })).toBe('pro')
    expect(getWorkspacePlan({ plan: 'free' })).toBe('free')
    expect(getWorkspacePlan({ plan: 'starter' })).toBe('starter')
    expect(getWorkspacePlan({ plan: 'pro' })).toBe('pro')
  })

  it('falls back to free for invalid or missing plans', () => {
    expect(getWorkspacePlan({ plan: 'invalid' })).toBe('free')
    expect(getWorkspacePlan({ plan: null })).toBe('free')
    expect(getWorkspacePlan({})).toBe('free')
  })

  it('free plan has no features — structural shell only', () => {
    expect(hasFeature('free', 'ai.agent')).toBe(false)
    expect(hasFeature('free', 'ai.byoa')).toBe(false)
    expect(hasFeature('free', 'ai.studio_key')).toBe(false)
    expect(hasFeature('free', 'media.library')).toBe(false)
    expect(hasFeature('free', 'media.upload')).toBe(false)
    expect(hasFeature('free', 'cdn.delivery')).toBe(false)
    expect(hasFeature('free', 'forms.enabled')).toBe(false)
    expect(hasFeature('free', 'git.connect')).toBe(false)
    expect(hasFeature('free', 'projects.create')).toBe(false)
    expect(hasFeature('free', 'api.mcp_cloud')).toBe(false)
  })

  it('resolves feature flags — paid plans have full features except enterprise-only', () => {
    expect(hasFeature('starter', 'workflow.review')).toBe(true)
    expect(hasFeature('pro', 'workflow.review')).toBe(true)
    expect(hasFeature('starter', 'cdn.delivery')).toBe(true)
    expect(hasFeature('starter', 'media.upload')).toBe(true)
    expect(hasFeature('starter', 'git.connect')).toBe(true)
    expect(hasFeature('starter', 'projects.create')).toBe(true)
    expect(hasFeature('enterprise', 'sso.saml')).toBe(true)
    expect(hasFeature('starter', 'sso.saml')).toBe(false)
    expect(hasFeature('pro', 'sso.saml')).toBe(false)
  })

  it('gates tier-specific features correctly', () => {
    expect(hasFeature('starter', 'media.custom_variants')).toBe(false)
    expect(hasFeature('pro', 'media.custom_variants')).toBe(true)
    expect(hasFeature('starter', 'roles.specific_models')).toBe(false)
    expect(hasFeature('pro', 'roles.specific_models')).toBe(true)
    expect(hasFeature('starter', 'cdn.preview_branch')).toBe(false)
    expect(hasFeature('pro', 'cdn.preview_branch')).toBe(true)
  })

  it('free plan limits are zero — the tier is a structural shell', () => {
    expect(getPlanLimit('free', 'ai.messages_per_month')).toBe(0)
    expect(getPlanLimit('free', 'team.members')).toBe(1) // 1 owner seat so the workspace row can exist
    expect(getPlanLimit('free', 'cdn.api_keys')).toBe(0)
    expect(getPlanLimit('free', 'forms.models')).toBe(0)
    expect(getPlanLimit('free', 'api.mcp_calls_per_month')).toBe(0)
  })

  it('returns consistent feature lists and plan limits', () => {
    expect(getAvailableFeatures('starter')).toContain('cdn.delivery')
    expect(getAvailableFeatures('pro')).toContain('cdn.delivery')
    expect(getAvailableFeatures('free')).not.toContain('cdn.delivery')
    expect(getPlanLimit('starter', 'cdn.api_keys')).toBe(3)
    expect(getPlanLimit('pro', 'team.members')).toBe(25)
    expect(getPlanLimit('starter', 'ai.messages_per_month')).toBe(150)
    expect(getPlanLimit('pro', 'ai.messages_per_month')).toBe(1_500)
  })
})
