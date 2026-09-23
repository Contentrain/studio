import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PLAN_PRICING, getPlanParams, getUpgradeParams } from '../../shared/utils/license'
import { creditLimitsFor } from '../../shared/utils/credit-unit'

/**
 * The agent quotes the workspace's quotas (`plan.pro` / `plan.starter`
 * prompts). A subscription sold before catalog v2 keeps its $0.03 terms —
 * Pro 350 AI / 140 API credits — and must not be told the v2 1 600 / 450.
 */
function renderPlanPrompt(key: string, params?: Record<string, unknown>): string {
  return key === 'plan.pro' || key === 'plan.starter'
    ? `[${key} ai=${String(params?.aiMessages)} api=${String(params?.apiMessages)}]`
    : `[prompt:${key}]`
}

describe('agent prompt — quotas in the account\'s own credit terms', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('agentPrompt', renderPlanPrompt)
    // Nitro auto-imports the prompt builder reads as globals.
    vi.stubGlobal('getPlanParams', getPlanParams)
    vi.stubGlobal('getUpgradeParams', getUpgradeParams)
    vi.stubGlobal('PLAN_PRICING', PLAN_PRICING)
  })

  async function staticBody(plan: 'pro' | 'starter', creditUnit?: '0.03' | '0.01') {
    const { buildSystemPromptBlocks } = await import('../../server/utils/agent-system-prompt')
    return buildSystemPromptBlocks(
      { stack: 'nuxt', domains: ['system'], workflow: 'auto-merge', locales: { default: 'en', supported: ['en'] } } as never,
      [] as never,
      { workspaceRole: 'owner', projectRole: null, specificModels: false, allowedModels: [], availableTools: ['save_content'] },
      { initialized: true, pendingBranches: [], projectStatus: 'active', phase: 'active', contentContext: null } as never,
      { activeModelId: null, activeLocale: 'en', activeEntryId: null, panelState: 'overview', activeBranch: null, contextItems: [] } as never,
      { category: 'update_content', confidence: 'low', inferred: {} } as never,
      null,
      null,
      plan,
      null,
      undefined,
      'ee',
      undefined,
      creditUnit,
    ).static
  }

  it('tells a pre-v2 Pro its own 350 AI / 140 API credits', async () => {
    const body = await staticBody('pro', '0.03')
    expect(body).toContain('[plan.pro ai=350 api=140]')
  })

  it('tells a v2 Pro the catalog\'s 1,600 / 450 — spelled out, never rounded to "2K"', async () => {
    expect(await staticBody('pro', '0.01')).toContain('[plan.pro ai=1,600 api=450]')
    // No account unit (free, self-hosted): the current catalog.
    expect(await staticBody('pro')).toContain('[plan.pro ai=1,600 api=450]')
  })

  it('tells a pre-v2 Starter its own 60 credits', async () => {
    expect(await staticBody('starter', '0.03')).toContain('[plan.starter ai=60 api=30]')
  })
})

describe('getPlanParams — credit limits and number formatting', () => {
  it('takes the account\'s credit limits when given', () => {
    expect(getPlanParams('pro', creditLimitsFor('pro', '0.03'))).toMatchObject({ aiMessages: '350', apiMessages: '140' })
    expect(getPlanParams('pro')).toMatchObject({ aiMessages: '1,600', apiMessages: '450' })
  })

  it('keeps whole thousands short and spells the rest out', () => {
    expect(getPlanParams('pro')).toMatchObject({ formSubmissions: '3K', mcpCalls: '150K' })
  })
})
