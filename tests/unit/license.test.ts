import { describe, expect, it } from 'vitest'
import { getAvailableFeatures, getPlanLimit, getWorkspacePlan, hasFeature } from '../../server/utils/license'

describe('license utilities', () => {
  it('normalizes legacy plan names', () => {
    expect(getWorkspacePlan({ plan: 'team' })).toBe('pro')
    expect(getWorkspacePlan({ plan: 'business' })).toBe('pro')
    expect(getWorkspacePlan({ plan: 'free' })).toBe('starter')
    expect(getWorkspacePlan({ plan: 'starter' })).toBe('starter')
    expect(getWorkspacePlan({ plan: 'pro' })).toBe('pro')
  })

  it('falls back to starter for invalid plans', () => {
    expect(getWorkspacePlan({ plan: 'invalid' })).toBe('starter')
    expect(getWorkspacePlan({ plan: null })).toBe('starter')
    expect(getWorkspacePlan({})).toBe('starter')
  })

  it('resolves feature flags — all features on all plans except enterprise-only', () => {
    expect(hasFeature('starter', 'workflow.review')).toBe(true)
    expect(hasFeature('pro', 'workflow.review')).toBe(true)
    expect(hasFeature('starter', 'cdn.delivery')).toBe(true)
    expect(hasFeature('starter', 'media.upload')).toBe(true)
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

  it('returns consistent feature lists and plan limits', () => {
    expect(getAvailableFeatures('starter')).toContain('cdn.delivery')
    expect(getAvailableFeatures('pro')).toContain('cdn.delivery')
    expect(getPlanLimit('starter', 'cdn.api_keys')).toBe(3)
    expect(getPlanLimit('pro', 'team.members')).toBe(25)
  })
})
