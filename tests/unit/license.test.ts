import { describe, expect, it } from 'vitest'
import { getAvailableFeatures, getPlanLimit, getWorkspacePlan, hasFeature } from '../../server/utils/license'

describe('license utilities', () => {
  it('normalizes legacy team plan to business', () => {
    expect(getWorkspacePlan({ plan: 'team' })).toBe('business')
  })

  it('falls back to free for invalid plans', () => {
    expect(getWorkspacePlan({ plan: 'starter' })).toBe('free')
    expect(getWorkspacePlan({ plan: null })).toBe('free')
  })

  it('resolves feature flags through the feature matrix', () => {
    expect(hasFeature('free', 'workflow.review')).toBe(false)
    expect(hasFeature('pro', 'workflow.review')).toBe(true)
    expect(hasFeature('enterprise', 'sso.saml')).toBe(true)
  })

  it('returns consistent feature lists and plan limits', () => {
    expect(getAvailableFeatures('pro')).toContain('cdn.delivery')
    expect(getPlanLimit('free', 'cdn.api_keys')).toBe(0)
    expect(getPlanLimit('business', 'team.members')).toBe(50)
  })
})
