import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

function stubRouteGlobals(branch: string) {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', createErrorLike)
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
    user: { id: 'user-1' },
    accessToken: 'token-1',
  }))
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string, opts?: { decode?: boolean }) => {
    if (key === 'workspaceId') return 'workspace-1'
    if (key === 'projectId') return 'project-1'
    // Mirror h3: the raw param is returned verbatim unless { decode: true }.
    if (key === 'branch') return opts?.decode ? decodeURIComponent(branch) : branch
    return undefined
  }))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('useDatabaseProvider', vi.fn(() => ({
    getUserClient: vi.fn((accessToken: string) => {
      const userClient = (globalThis as typeof globalThis & {
        useSupabaseUserClient?: (token: string) => unknown
      }).useSupabaseUserClient
      return typeof userClient === 'function' ? userClient(accessToken) : {}
    }),
    listApprovals: vi.fn().mockResolvedValue([]),
    clearApprovals: vi.fn().mockResolvedValue(undefined),
    recordReceipt: vi.fn().mockResolvedValue({}),
  })))
  // The merge route resolves the project's workflow before touching git: an
  // auto-merge project is not asked for approvals, which is what these cases are.
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('starter'))
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { workflow: 'auto-merge' }, approvalPolicy: null }))
}

/** A bare h3 event: real ones always carry `context`, mocks have to as well. */
function routeEvent() {
  return { context: {} } as never
}

describe('branch moderation routes', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('blocks merge requests for non-contentrain branches', async () => {
    stubRouteGlobals('feature/direct-edit')
    vi.stubGlobal('resolveAgentPermissions', vi.fn())

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/merge.post')).default

    await expect(handler(routeEvent())).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('blocks merge requests without reviewer permissions', async () => {
    stubRouteGlobals('cr/content/faq/en/1234567890-abcd')
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['list_branches'],
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/merge.post')).default

    await expect(handler(routeEvent())).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('delegates merge operations to the content engine for valid contentrain branches', async () => {
    const mergeBranch = vi.fn().mockResolvedValue({
      merged: true,
      sha: 'merge-sha',
      pullRequestUrl: null,
    })

    stubRouteGlobals('cr/content/faq/en/1234567890-abcd')
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['merge_branch'],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {},
      contentRoot: '',
    }))
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({
      mergeBranch,
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/merge.post')).default
    const result = await handler(routeEvent())

    expect(mergeBranch).toHaveBeenCalledWith('cr/content/faq/en/1234567890-abcd')
    expect(result).toEqual({
      merged: true,
      sha: 'merge-sha',
      pullRequestUrl: null,
    })
  })

  it('decodes percent-encoded branch names before merging (cr/* names contain slashes)', async () => {
    const mergeBranch = vi.fn().mockResolvedValue({
      merged: true,
      sha: 'merge-sha',
      pullRequestUrl: null,
    })

    // The client sends the branch percent-encoded (encodeURIComponent), since
    // cr/* names contain slashes. Without { decode: true } the handler would
    // see "cr%2F..." and 400 on the startsWith('cr/') guard.
    stubRouteGlobals('cr%2Fcontent%2Ffaq%2Fen%2F1234567890-abcd')
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['merge_branch'],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {},
      contentRoot: '',
    }))
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({
      mergeBranch,
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/merge.post')).default
    const result = await handler(routeEvent())

    // The decoded name must reach the engine.
    expect(mergeBranch).toHaveBeenCalledWith('cr/content/faq/en/1234567890-abcd')
    expect(result).toEqual({
      merged: true,
      sha: 'merge-sha',
      pullRequestUrl: null,
    })
  })

  /** A review project whose policy has to be satisfied before the branch lands. */
  function stubReviewProject(approvalPolicy: unknown, approvals: unknown[] = []) {
    const db = {
      getUserClient: vi.fn().mockReturnValue({}),
      listApprovals: vi.fn().mockResolvedValue(approvals),
      clearApprovals: vi.fn().mockResolvedValue(undefined),
      recordReceipt: vi.fn().mockResolvedValue({}),
    }
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
      models: new Map(),
      content: new Map(),
      config: { workflow: 'review', locales: { default: 'en', supported: ['en'] } },
      approvalPolicy,
    }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {
        getBranchDiff: vi.fn().mockResolvedValue([]),
        listBranches: vi.fn().mockResolvedValue([{ name: 'cr/content/faq/en/1234567890-abcd', sha: 'tip-sha', protected: false }]),
        readFile: vi.fn().mockRejectedValue(new Error('absent')),
      },
      contentRoot: '',
      workspace: { plan: 'pro' },
    }))
    return db
  }

  it('refuses to merge a branch the project policy still holds', async () => {
    // The hole S-05 left: the policy said "one review on the diff" and a person
    // pressing Merge satisfied it without anything recording a review.
    const mergeBranch = vi.fn()
    stubRouteGlobals('cr/content/faq/en/1234567890-abcd')
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({ availableTools: ['merge_branch'], workspaceRole: 'owner' }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    stubReviewProject(null)
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({ mergeBranch }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/merge.post')).default

    await expect(handler(routeEvent())).rejects.toMatchObject({ statusCode: 403 })
    expect(mergeBranch).not.toHaveBeenCalled()
  })

  it('merges and records a receipt once the policy is satisfied', async () => {
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true, sha: 'merge-sha', pullRequestUrl: null })
    stubRouteGlobals('cr/content/faq/en/1234567890-abcd')
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({ availableTools: ['merge_branch'], workspaceRole: 'owner' }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    // A policy that trusts this class outright — no grant to collect, and the
    // receipt still records what ran and under which plan.
    const db = stubReviewProject({ version: 1, rules: [{ risk: 'low_risk_content', gate: 'change', mode: 'auto' }] })
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({ mergeBranch }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/merge.post')).default
    const result = await handler(routeEvent())

    expect(mergeBranch).toHaveBeenCalledWith('cr/content/faq/en/1234567890-abcd')
    expect(result).toMatchObject({ merged: true })
    expect(db.recordReceipt).toHaveBeenCalledTimes(1)
    const receipt = db.recordReceipt.mock.calls[0]![0] as { target: string, planHash: string, receipt: { status: string, plan_hash: string } }
    expect(receipt.target).toBe('cr/content/faq/en/1234567890-abcd')
    expect(receipt.receipt.status).toBe('completed')
    expect(receipt.receipt.plan_hash).toBe(receipt.planHash)
    // A landed branch's grants are grants of nothing.
    expect(db.clearApprovals).toHaveBeenCalledWith('project-1', 'cr/content/faq/en/1234567890-abcd')
  })

  it('delegates reject operations to the content engine for valid contentrain branches', async () => {
    const rejectBranch = vi.fn().mockResolvedValue(undefined)

    stubRouteGlobals('cr/content/faq/en/1234567890-abcd')
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['reject_branch'],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {},
      contentRoot: '',
    }))
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({
      rejectBranch,
    }))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/reject.post')).default
    const result = await handler(routeEvent())

    expect(rejectBranch).toHaveBeenCalledWith('cr/content/faq/en/1234567890-abcd')
    expect(result).toEqual({ rejected: true })
  })
})
