import { describe, expect, it } from 'vitest'
import { applyTrialCap, PLAN_LIMITS } from '../../shared/utils/license'
import { chatModelIdsFor, premiumModelsAllowed } from '../../shared/utils/ai-models'
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
    expect(chatModelIdsFor(true, { premium: false })).toContain('claude-sonnet-5')
  })
})
