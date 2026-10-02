import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeToContentrain } from '../../server/utils/content-engine/branch-ops'
import type { EngineInternalContext } from '../../server/utils/content-engine/types'

/**
 * An approval covers the commit it was decided on. Between the approval check
 * and the merge a new commit could land on the branch, and a merge by branch
 * name would carry it in unreviewed. The merge is pinned to the approved SHA.
 */

const BRANCH = 'cr/content/faq/en/1234567890-abcd'

function fakeGit(tips: Record<string, string>) {
  return {
    listBranches: vi.fn(async () => Object.entries(tips).map(([name, sha]) => ({ name, sha, protected: false }))),
    fastForwardBranch: vi.fn(async (_into: string, _sha: string) => true),
    mergeBranch: vi.fn(async () => ({ merged: true, sha: 'merge-sha', pullRequestUrl: null })),
    deleteBranch: vi.fn(async () => {}),
  }
}

function ctx(git: ReturnType<typeof fakeGit>) {
  return { git } as unknown as EngineInternalContext
}

describe('pinned merge', () => {
  it('lands exactly the approved commit', async () => {
    const git = fakeGit({ [BRANCH]: 'approved', contentrain: 'base' })

    await expect(mergeToContentrain(ctx(git), BRANCH, { expectedHead: 'approved' })).resolves.toEqual({ merged: true, sha: 'approved' })
    expect(git.fastForwardBranch).toHaveBeenCalledWith('contentrain', 'approved')
  })

  it('refuses a branch that moved after the approval, and touches nothing', async () => {
    const git = fakeGit({ [BRANCH]: 'pushed-later', contentrain: 'base' })

    await expect(mergeToContentrain(ctx(git), BRANCH, { expectedHead: 'approved' })).rejects.toMatchObject({
      code: 'branch_moved',
      expected: 'approved',
      actual: 'pushed-later',
    })
    expect(git.fastForwardBranch).not.toHaveBeenCalled()
    expect(git.mergeBranch).not.toHaveBeenCalled()
    expect(git.deleteBranch).not.toHaveBeenCalled()
  })

  it('lands the approved SHA, not the branch name, when it cannot fast-forward', async () => {
    const git = { ...fakeGit({ [BRANCH]: 'approved', contentrain: 'base' }), mergeCommit: vi.fn(async () => ({ merged: true, sha: 'merge-sha', pullRequestUrl: null })) }
    git.fastForwardBranch.mockResolvedValue(false)

    await expect(mergeToContentrain(ctx(git), BRANCH, { expectedHead: 'approved' })).resolves.toEqual({ merged: true, sha: 'merge-sha' })
    expect(git.mergeCommit).toHaveBeenCalledWith('approved', 'contentrain')
    expect(git.mergeBranch).not.toHaveBeenCalled()
  })

  it('merges by name when the provider cannot merge a bare SHA', async () => {
    const git = fakeGit({ [BRANCH]: 'approved', contentrain: 'base' })
    git.fastForwardBranch.mockResolvedValue(false)

    await expect(mergeToContentrain(ctx(git), BRANCH, { expectedHead: 'approved' })).resolves.toMatchObject({ merged: true })
    expect(git.mergeBranch).toHaveBeenCalledWith(BRANCH, 'contentrain')
  })

  it('fails closed when the tips cannot be read, and touches nothing', async () => {
    const git = fakeGit({ [BRANCH]: 'approved', contentrain: 'base' })
    git.listBranches.mockRejectedValue(new Error('GitHub 502'))

    await expect(mergeToContentrain(ctx(git), BRANCH, { expectedHead: 'approved' })).rejects.toMatchObject({ code: 'branch_tip_unreadable', branch: BRANCH })
    expect(git.fastForwardBranch).not.toHaveBeenCalled()
    expect(git.mergeBranch).not.toHaveBeenCalled()
    expect(git.deleteBranch).not.toHaveBeenCalled()
  })

  it('merges unpinned as before when nothing was approved', async () => {
    const git = fakeGit({ [BRANCH]: 'whatever', contentrain: 'base' })

    await expect(mergeToContentrain(ctx(git), BRANCH)).resolves.toMatchObject({ merged: true })
    expect(git.fastForwardBranch).toHaveBeenCalledWith('contentrain', 'whatever')
  })
})

describe('resolveMergeApproval pins the reviewed tip', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function resolve(tips: string[]) {
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
      models: new Map(),
      content: new Map(),
      config: { workflow: 'review', locales: { default: 'en', supported: ['en'] } },
      approvalPolicy: null,
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn(() => ({ listApprovals: vi.fn().mockResolvedValue([]) })))
    const listBranches = vi.fn()
    for (const sha of tips) listBranches.mockResolvedValueOnce([{ name: BRANCH, sha, protected: false }])
    const git = { listBranches, getBranchDiff: vi.fn().mockResolvedValue([]), readFile: vi.fn().mockRejectedValue(new Error('absent')) }
    const { resolveMergeApproval } = await import('../../server/utils/branch-approval')
    return resolveMergeApproval({ git: git as never, contentRoot: '', projectId: 'p1', branch: BRANCH, workflow: 'review', policy: null })
  }

  it('returns the tip the review was read at', async () => {
    await expect(resolve(['tip-1', 'tip-1'])).resolves.toMatchObject({ commitSha: 'tip-1' })
  })

  it('fails closed when the tip cannot be read, instead of merging unpinned', async () => {
    vi.stubGlobal('getOrBuildBrainCache', vi.fn())
    const git = { listBranches: vi.fn().mockRejectedValue(new Error('GitHub 502')), getBranchDiff: vi.fn(), readFile: vi.fn() }
    const { resolveMergeApproval } = await import('../../server/utils/branch-approval')

    await expect(resolveMergeApproval({ git: git as never, contentRoot: '', projectId: 'p1', branch: BRANCH, workflow: 'review', policy: null }))
      .rejects.toMatchObject({ code: 'branch_tip_unreadable' })
    expect(git.getBranchDiff).not.toHaveBeenCalled()
  })

  it('refuses when a commit lands while the review is read', async () => {
    // Otherwise one commit's review would be paired with another commit's SHA.
    await expect(resolve(['tip-1', 'tip-2'])).rejects.toMatchObject({ code: 'branch_moved', expected: 'tip-1', actual: 'tip-2' })
  })
})
