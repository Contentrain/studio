import { describe, expect, it } from 'vitest'
import { applyTrialCap, PLAN_LIMITS } from '../../shared/utils/license'
import { chatModelIdsFor, premiumModelsAllowed, resolveChatModelId } from '../../shared/utils/ai-models'
import { resolveTrialContext } from '../../server/utils/billing'

const AI = 'ai.messages_per_month'
const API = 'api.messages_per_month'

describe('applyTrialCap', () => {
  it('reads the cap from the catalog: AI and API credits capped at Starter for Migrate trials', () => {
    expect(PLAN_LIMITS[AI]!.trialCap).toEqual({ plan: 'starter', origins: 'migrate' })
    expect(PLAN_LIMITS[API]!.trialCap).toEqual({ plan: 'starter', origins: 'migrate' })
  })

  it('caps a Migrate trial at the Starter value', () => {
    const pro = PLAN_LIMITS[AI]!.values.pro
    expect(applyTrialCap(pro, AI, { trialing: true, origin: 'migrate' })).toBe(PLAN_LIMITS[AI]!.values.starter)
    expect(applyTrialCap(PLAN_LIMITS[API]!.values.pro, API, { trialing: true, origin: 'migrate' })).toBe(PLAN_LIMITS[API]!.values.starter)
  })

  it('leaves the limit alone outside a trial, for other origins, and for rows without a cap', () => {
    const pro = PLAN_LIMITS[AI]!.values.pro
    expect(applyTrialCap(pro, AI, { trialing: false, origin: 'migrate' })).toBe(pro)
    expect(applyTrialCap(pro, AI, { trialing: true, origin: 'standard' })).toBe(pro)
    expect(applyTrialCap(pro, AI, null)).toBe(pro)
    expect(applyTrialCap(5, 'cdn.bandwidth_gb', { trialing: true, origin: 'migrate' })).toBe(5)
  })

  it('never raises a limit', () => {
    expect(applyTrialCap(10, AI, { trialing: true, origin: 'migrate' })).toBe(10)
  })
})

describe('resolveTrialContext', () => {
  it('reads the Migrate origin the webhook records on the payment account', () => {
    expect(resolveTrialContext('trial_active', { plugin_metadata: { trial_origin: 'migrate' } })).toEqual({ trialing: true, origin: 'migrate' })
    expect(resolveTrialContext('trial_active', { plugin_metadata: {} })).toEqual({ trialing: true, origin: 'standard' })
    expect(resolveTrialContext('subscribed', { plugin_metadata: { trial_origin: 'migrate' } })).toEqual({ trialing: false, origin: 'migrate' })
    expect(resolveTrialContext('free', null)).toEqual({ trialing: false, origin: 'standard' })
  })
})

describe('premium models in a trial', () => {
  it('closes premium models only for a trial on the Studio key', () => {
    expect(premiumModelsAllowed({ billingState: 'trial_active', usageSource: 'studio' })).toBe(false)
    expect(premiumModelsAllowed({ billingState: 'trial_active', usageSource: 'byoa' })).toBe(true)
    expect(premiumModelsAllowed({ billingState: 'subscribed', usageSource: 'studio' })).toBe(true)
    expect(premiumModelsAllowed({ billingState: 'past_due', usageSource: 'studio' })).toBe(true)
  })

  it('filters by the catalog `premium` flag, not a model-ID list', () => {
    expect(chatModelIdsFor(true)).toContain('claude-opus-5-5')
    expect(chatModelIdsFor(true, { premium: false })).not.toContain('claude-opus-5-5')
    expect(chatModelIdsFor(true, { premium: false })).toContain('claude-sonnet-5-5')
  })
})

describe('resolveChatModelId (stored and requested model IDs)', () => {
  it('keeps a catalog ID as is', () => {
    for (const id of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
      expect(resolveChatModelId(id)).toBe(id)
  })

  it('moves a retired ID to its family\'s current model', () => {
    expect(resolveChatModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-5-5')
    expect(resolveChatModelId('claude-haiku-4-5')).toBe('claude-haiku-5-5')
    expect(resolveChatModelId('claude-sonnet-5')).toBe('claude-sonnet-5-5')
    expect(resolveChatModelId('claude-sonnet-4-6')).toBe('claude-sonnet-5-5')
    expect(resolveChatModelId('claude-sonnet-4-20250514')).toBe('claude-sonnet-5-5')
    expect(resolveChatModelId('claude-3-5-sonnet-20241022')).toBe('claude-sonnet-5-5')
    expect(resolveChatModelId('claude-opus-5')).toBe('claude-opus-5-5')
    expect(resolveChatModelId('claude-opus-4-8')).toBe('claude-opus-5-5')
    expect(resolveChatModelId('claude-opus-4-1-20250805')).toBe('claude-opus-5-5')
  })

  it('returns null for anything without a catalog family, so the caller keeps its default', () => {
    for (const id of [null, undefined, '', 'claude-fable-5-1', 'claude-mythos-5', 'gpt-4o', 'claude-sonnetx-1'])
      expect(resolveChatModelId(id)).toBeNull()
  })
})
