import { describe, expect, it } from 'vitest'
import { dictionary } from '#contentrain'
import { hasFeatureForPlan as hasFeature } from '../../shared/utils/license'

/**
 * What the assistant and the error messages tell customers about plans must
 * match the plan data. They said "All features available on all plans" and
 * "BYOA available" on Starter, and returned "Conversation API is available on
 * all plans" to a Starter workspace that the same route had just refused.
 */
const prompts = dictionary('agent-prompts').locale('en').get() as Record<string, string>
const errors = dictionary('error-messages').locale('en').get() as Record<string, string>

describe('plan copy matches plan data', () => {
  it('the data this test relies on: BYOA and the Conversation API are Pro-only', () => {
    expect(hasFeature('starter', 'ai.byoa')).toBe(false)
    expect(hasFeature('starter', 'api.conversation')).toBe(false)
    expect(hasFeature('pro', 'ai.byoa')).toBe(true)
    expect(hasFeature('pro', 'api.conversation')).toBe(true)
  })

  it('no prompt or error claims every feature is on every plan', () => {
    for (const [key, text] of Object.entries({ ...prompts, ...errors }))
      expect(text, key).not.toMatch(/available on all plans|features available on all plans/i)
  })

  it('the Starter prompt does not offer BYOA or a Conversation API key', () => {
    expect(prompts['plan.starter']).not.toMatch(/BYOA available/i)
    expect(prompts['plan.starter']).not.toMatch(/\{conversationKeys\}/)
  })

  it('the Pro prompt does not sell roadmap items as included', () => {
    expect(prompts['plan.pro']).not.toMatch(/preview branches|spam filter/i)
  })

  it('usage is counted in credits, not messages', () => {
    for (const key of ['plan.starter', 'plan.pro'])
      expect(prompts[key], key).not.toMatch(/AI messages/i)
  })
})
