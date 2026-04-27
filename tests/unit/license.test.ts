import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAvailableFeatures, getPlanLimit, getWorkspacePlan, hasFeature } from '../../server/utils/license'
import { __resetDeploymentCache } from '../../server/utils/deployment'
import { setEnterpriseBridgeForTesting } from '../../server/utils/enterprise'
import type { EnterpriseBridge } from '../../server/utils/enterprise'

// Minimal fake bridge — makes `getLoadedEnterpriseBridge()` return
// non-null so `detectEdition()` reports `'ee'`. The fake handlers are
// no-ops because the license helpers never invoke them.
const FAKE_BRIDGE: EnterpriseBridge = {
  listWorkspaceAiKeys: async () => null,
  createWorkspaceAiKey: async () => null,
  deleteWorkspaceAiKey: async () => null,
  listProjectWebhooks: async () => null,
  createProjectWebhook: async () => null,
  updateProjectWebhook: async () => null,
  deleteProjectWebhook: async () => null,
  testProjectWebhook: async () => null,
  listWebhookDeliveries: async () => null,
  listProjectConversationKeys: async () => null,
  createProjectConversationKey: async () => null,
  updateProjectConversationKey: async () => null,
  deleteProjectConversationKey: async () => null,
  handleConversationApiMessage: async () => null,
  handleConversationApiHistory: async () => null,
}

// Mock useRuntimeConfig — simulate Stripe configured (Managed mode).
vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
  stripe: { secretKey: 'sk_test_mock' },
  polar: { accessToken: '' },
}))

describe('license utilities', () => {
  beforeEach(() => {
    // Inject EE bridge + reset deployment cache so `resolveDeployment()`
    // picks it up. Without this the tests would run under `edition='agpl'`
    // and `requires_ee` features would be force-disabled.
    setEnterpriseBridgeForTesting(FAKE_BRIDGE)
    __resetDeploymentCache()
  })

  afterEach(() => {
    setEnterpriseBridgeForTesting(null)
    __resetDeploymentCache()
  })

  it('normalizes legacy plan names', () => {
    expect(getWorkspacePlan({ plan: 'team' })).toBe('pro')
    expect(getWorkspacePlan({ plan: 'business' })).toBe('pro')
    expect(getWorkspacePlan({ plan: 'free' })).toBe('free')
    expect(getWorkspacePlan({ plan: 'starter' })).toBe('starter')
    expect(getWorkspacePlan({ plan: 'pro' })).toBe('pro')
  })

  it('falls back to free for invalid or missing plans under subscription-driven managed profile', () => {
    expect(getWorkspacePlan({ plan: 'invalid' })).toBe('free')
    expect(getWorkspacePlan({ plan: null })).toBe('free')
    expect(getWorkspacePlan({})).toBe('free')
  })

  it('free plan has no features — structural shell only', () => {
    expect(hasFeature('free', 'ai.byoa')).toBe(false)
    expect(hasFeature('free', 'ai.studio_key')).toBe(false)
    expect(hasFeature('free', 'media.library')).toBe(false)
    expect(hasFeature('free', 'media.upload')).toBe(false)
    expect(hasFeature('free', 'cdn.delivery')).toBe(false)
    expect(hasFeature('free', 'forms.enabled')).toBe(false)
    expect(hasFeature('free', 'api.mcp_cloud')).toBe(false)
  })

  it('resolves paid-plan features correctly in EE edition', () => {
    expect(hasFeature('starter', 'workflow.review')).toBe(true)
    expect(hasFeature('pro', 'workflow.review')).toBe(true)
    expect(hasFeature('starter', 'cdn.delivery')).toBe(true)
    expect(hasFeature('starter', 'media.upload')).toBe(true)
    expect(hasFeature('starter', 'forms.enabled')).toBe(true)
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

  it('ai.byoa now sits at Pro+ to match UI copy', () => {
    expect(hasFeature('starter', 'ai.byoa')).toBe(false)
    expect(hasFeature('pro', 'ai.byoa')).toBe(true)
    expect(hasFeature('enterprise', 'ai.byoa')).toBe(true)
  })

  it('api.conversation is Pro+ and requires_ee', () => {
    expect(hasFeature('starter', 'api.conversation')).toBe(false)
    expect(hasFeature('pro', 'api.conversation')).toBe(true)
  })

  it('free plan limits are zero — the tier is a structural shell', () => {
    expect(getPlanLimit('free', 'ai.messages_per_month')).toBe(0)
    expect(getPlanLimit('free', 'team.members')).toBe(1)
    expect(getPlanLimit('free', 'cdn.api_keys')).toBe(0)
    expect(getPlanLimit('free', 'forms.models')).toBe(0)
    expect(getPlanLimit('free', 'api.mcp_calls_per_month')).toBe(0)
  })

  it('returns consistent feature lists and plan limits in EE edition', () => {
    expect(getAvailableFeatures('starter')).toContain('cdn.delivery')
    expect(getAvailableFeatures('pro')).toContain('cdn.delivery')
    expect(getAvailableFeatures('free')).not.toContain('cdn.delivery')
    expect(getPlanLimit('starter', 'cdn.api_keys')).toBe(3)
    expect(getPlanLimit('pro', 'team.members')).toBe(25)
    expect(getPlanLimit('starter', 'ai.messages_per_month')).toBe(150)
    expect(getPlanLimit('pro', 'ai.messages_per_month')).toBe(1_500)
  })

  it('Community Edition force-disables requires_ee features regardless of plan', () => {
    setEnterpriseBridgeForTesting(null)
    __resetDeploymentCache()
    // In Community Edition `getWorkspacePlan` returns the fixed
    // `community` tier, and every `requires_ee: true` feature is
    // reported as unavailable.
    expect(getWorkspacePlan({ plan: 'pro' })).toBe('community')
    expect(hasFeature('community', 'cdn.delivery')).toBe(false)
    expect(hasFeature('community', 'media.upload')).toBe(false)
    expect(hasFeature('community', 'roles.reviewer')).toBe(false)
    // Core features still work in Community Edition.
    expect(hasFeature('community', 'forms.enabled')).toBe(true)
    expect(hasFeature('community', 'workflow.review')).toBe(true)
    expect(hasFeature('community', 'api.mcp_cloud')).toBe(true)
  })

  it('Community Edition limits for requires_ee keys are zeroed', () => {
    setEnterpriseBridgeForTesting(null)
    __resetDeploymentCache()
    expect(getPlanLimit('community', 'cdn.bandwidth_gb')).toBe(0)
    expect(getPlanLimit('community', 'media.storage_gb')).toBe(0)
    // Core limits stay unlimited (Infinity) under community.
    expect(getPlanLimit('community', 'team.members')).toBe(Infinity)
    expect(getPlanLimit('community', 'forms.submissions_per_month')).toBe(Infinity)
  })
})
