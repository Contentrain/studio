import { describe, expect, it, vi } from 'vitest'
import errorMessages from '../../.contentrain/content/system/error-messages/en.json'
import agentPrompts from '../../.contentrain/content/system/agent-prompts/en.json'
import { agentPrompt, errorMessage } from '../../server/utils/content-strings'
import {
  FEATURE_MATRIX,
  PLAN_PRICING,
  featuresMissingOnPlan,
  getPlanParams,
  getUpgradeParams,
  plansWithFeatureLabel,
} from '../../shared/utils/license'

/**
 * BG-1 P1-14: the agent prompt and error texts promised plan availability
 * the catalog does not grant — "Conversation API is available on all plans"
 * (Pro and Enterprise only), "BYOA available" on Starter (Pro+), "All features
 * available on all plans", preview branches and spam filter "included" on Pro
 * (roadmap). Plan availability now comes from the catalog at runtime.
 */

describe('plan availability wording comes from the catalog', () => {
  it('names the plans that grant a feature, and follows the catalog when it changes', () => {
    const entry = FEATURE_MATRIX['ai.byoa']!
    const before = [...entry.plans]
    const expected = (['starter', 'pro', 'enterprise'] as const).filter(p => before.includes(p)).map(p => PLAN_PRICING[p].name)
    expect(plansWithFeatureLabel('ai.byoa')).toBe(expected.length === 3 ? 'every paid plan' : expected.join(' and '))

    // PRC-3 moves BYOA to Starter: the text follows without an edit.
    entry.plans.push('starter')
    try {
      expect(plansWithFeatureLabel('ai.byoa')).toBe('every paid plan')
    }
    finally {
      entry.plans.splice(0, entry.plans.length, ...before)
    }
  })

  it('fills {plans:<feature>} in error texts without the caller passing it', () => {
    const text = errorMessage('conversation.upgrade')
    expect(text).toContain(plansWithFeatureLabel('api.conversation'))
    expect(text).not.toContain('{plans:')
    expect(text).not.toContain('all plans')
  })

  it('no error or agent text claims availability on "all plans" or "all features"', () => {
    const claims = /available on all plans|all features (are )?available/i
    const offenders = [
      ...Object.entries(errorMessages as Record<string, string>),
      ...Object.entries(agentPrompts as Record<string, string>),
    ].filter(([, text]) => claims.test(text)).map(([key]) => key)
    expect(offenders).toEqual([])
  })

  it('the Starter prompt lists what Starter lacks, from the catalog, and promises no BYOA', async () => {
    vi.stubGlobal('agentPrompt', agentPrompt)
    vi.stubGlobal('getPlanParams', getPlanParams)
    vi.stubGlobal('getUpgradeParams', getUpgradeParams)
    vi.stubGlobal('PLAN_PRICING', PLAN_PRICING)
    const { buildSystemPromptBlocks } = await import('../../server/utils/agent-system-prompt')
    const { static: body } = buildSystemPromptBlocks(
      { stack: 'nuxt', domains: ['system'], workflow: 'auto-merge', locales: { default: 'en', supported: ['en'] } } as never,
      [] as never,
      { workspaceRole: 'owner', projectRole: null, specificModels: false, allowedModels: [], availableTools: ['save_content'] },
      { initialized: true, pendingBranches: [], projectStatus: 'active', phase: 'active', contentContext: null } as never,
      { activeModelId: null, activeLocale: 'en', activeEntryId: null, panelState: 'overview', activeBranch: null, contextItems: [] } as never,
      { category: 'update_content', confidence: 'low', inferred: {} } as never,
      null,
      null,
      'starter',
      null,
      undefined,
      'ee',
    )
    expect(body).toContain(`Not included on Starter: ${featuresMissingOnPlan('starter').join(', ')}`)
    expect(body).not.toContain('BYOA available')
    expect(body).not.toMatch(/all features (are )?available/i)
  })
})
