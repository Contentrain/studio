import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Merge button's route and the chat agent's merge_branch answer to one
 * approval helper; this pins the route's side of that contract.
 */

const resolveMergeApproval = vi.fn()
const recordMergeReceipt = vi.fn()
vi.mock('../../server/utils/branch-approval', () => ({
  effectiveWorkflow: () => 'review',
  resolveMergeApproval: (...args: unknown[]) => resolveMergeApproval(...args),
  recordMergeReceipt: (...args: unknown[]) => recordMergeReceipt(...args),
}))

const BRANCH = 'cr/content/tags/en/1790466768-886f'

function stubGlobals(mergeBranch: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', (input: { statusCode: number, message: string, data?: unknown }) => Object.assign(new Error(input.message), input))
  vi.stubGlobal('errorMessage', (key: string) => key)
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'u1', email: 'owner@x.io' }, accessToken: 't' }))
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => ({ workspaceId: 'w1', projectId: 'p1', branch: BRANCH })[key]))
  vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({ availableTools: ['merge_branch'], workspaceRole: 'owner' }))
  vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({ git: {}, contentRoot: '', workspace: {} }))
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { workflow: 'review' }, approvalPolicy: null }))
  vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({ mergeBranch }))
  vi.stubGlobal('useDatabaseProvider', vi.fn(() => ({})))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
}

async function handler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/merge.post')).default
}

describe('merge route approval', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resolveMergeApproval.mockReset()
    recordMergeReceipt.mockReset()
  })

  it('refuses with 403 and the decision while the branch waits for approval', async () => {
    const mergeBranch = vi.fn()
    stubGlobals(mergeBranch)
    const decision = { allowed: false, reasons: ['change approval: 1 more needed (0/1)'] }
    resolveMergeApproval.mockResolvedValue({ plan: {}, grants: [], decision })

    await expect((await handler())({ context: {} } as never)).rejects.toMatchObject({
      statusCode: 403,
      message: 'branches.approval_required',
      data: { approval: decision },
    })
    expect(mergeBranch).not.toHaveBeenCalled()
    expect(recordMergeReceipt).not.toHaveBeenCalled()
  })

  it('merges an approved branch and records the receipt', async () => {
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true })
    stubGlobals(mergeBranch)
    const approval = { plan: {}, grants: [], decision: { allowed: true, reasons: [] } }
    resolveMergeApproval.mockResolvedValue(approval)

    await expect((await handler())({ context: {} } as never)).resolves.toEqual({ merged: true })
    expect(mergeBranch).toHaveBeenCalledWith(BRANCH)
    expect(recordMergeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      branch: BRANCH,
      approval,
      actor: expect.objectContaining({ id: 'owner@x.io', role: 'owner' }),
    }))
  })
})
