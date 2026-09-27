import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'

/**
 * The chat agent's merge_branch merged a branch the review panel showed at
 * 0/1 approvals: the tool called the engine directly and asked the approval
 * policy nothing. It answers to the same approval as the Merge button now.
 */

const resolveMergeApproval = vi.fn()
const recordMergeReceipt = vi.fn()
vi.mock('../../server/utils/branch-approval', () => ({
  resolveMergeApproval: (...args: unknown[]) => resolveMergeApproval(...args),
  recordMergeReceipt: (...args: unknown[]) => recordMergeReceipt(...args),
}))
vi.mock('../../server/utils/alert', () => ({ reportAgentToolError: vi.fn() }))

const BRANCH = 'cr/content/tags/en/1790466768-886f'
const PERMISSIONS: AgentPermissions = {
  workspaceRole: 'owner',
  projectRole: null,
  specificModels: false,
  allowedModels: [],
  allowedLocales: [],
  availableTools: ['merge_branch'],
}
const UI: ChatUIContext = { activeModelId: null, activeLocale: 'en', activeEntryId: null, panelState: 'overview', activeBranch: BRANCH }
const PLAN = { plan_hash: 'h1' }

function decision(allowed: boolean) {
  return {
    allowed,
    risk: 'low_risk_content',
    planHash: 'h1',
    intent: 'Content edit',
    scope: {},
    reasons: allowed ? [] : ['change approval: 1 more needed (0/1), because the plan is low_risk_content.'],
    requirements: [],
    rejectedGrants: [],
  }
}

async function runMerge(workflow: string) {
  const { emptyAffected } = await import('../../server/utils/agent-types')
  vi.stubGlobal('emptyAffected', emptyAffected)
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  vi.stubGlobal('agentMessage', vi.fn((key: string, params?: Record<string, unknown>) => params?.reasons ? `${key}: ${params.reasons}` : key))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('useDatabaseProvider', vi.fn(() => ({})))
  vi.stubGlobal('invalidateBrainCache', vi.fn())
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { workflow }, approvalPolicy: { version: 1 } }))
  const engine = { mergeBranch: vi.fn().mockResolvedValue({ merged: true, branch: BRANCH }) }
  const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
  const out = await executeToolWithAutoMerge(
    'merge_branch', { branch: BRANCH }, engine as never, {} as GitProvider, 'owner@x.io', 'u1', 'content', workflow, PERMISSIONS, 'pro', 'p1', 'w1', UI,
  )
  return { ...out, engine }
}

describe('merge_branch answers to the branch approval', () => {
  beforeAll(async () => {
    await import('../../server/utils/conversation-engine')
  }, 60_000)

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
    resolveMergeApproval.mockReset()
    recordMergeReceipt.mockReset()
  })

  it('refuses a branch still waiting for approval, even for the owner', async () => {
    resolveMergeApproval.mockResolvedValue({ plan: PLAN, grants: [], decision: decision(false) })

    const { result, engine, affected } = await runMerge('review')

    expect(engine.mergeBranch).not.toHaveBeenCalled()
    expect(recordMergeReceipt).not.toHaveBeenCalled()
    expect(result).toMatchObject({ merged: false, approval: { allowed: false } })
    expect((result as { error: string }).error).toBe('branch.approval_required: change approval: 1 more needed (0/1), because the plan is low_risk_content.')
    // Nothing moved, so the panel has nothing to refresh.
    expect(affected.branchesChanged).toBe(false)
    expect(resolveMergeApproval).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', branch: BRANCH, workflow: 'review', policy: { version: 1 } }))
  })

  it('merges an approved branch and keeps its receipt, like the Merge button', async () => {
    const approval = { plan: PLAN, grants: [{ approver: 'reviewer@x.io' }], decision: decision(true) }
    resolveMergeApproval.mockResolvedValue(approval)

    const { result, engine } = await runMerge('review')

    expect(engine.mergeBranch).toHaveBeenCalledWith(BRANCH)
    expect(result).toMatchObject({ merged: true })
    expect(recordMergeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1',
      workspaceId: 'w1',
      branch: BRANCH,
      approval,
      actor: expect.objectContaining({ id: 'owner@x.io', role: 'owner' }),
    }))
  })

  it('merges on an auto-merge project, which asks for no approval', async () => {
    resolveMergeApproval.mockResolvedValue(null)

    const { result, engine } = await runMerge('auto-merge')

    expect(engine.mergeBranch).toHaveBeenCalledWith(BRANCH)
    expect(result).toMatchObject({ merged: true })
    expect(recordMergeReceipt).not.toHaveBeenCalled()
  })
})
