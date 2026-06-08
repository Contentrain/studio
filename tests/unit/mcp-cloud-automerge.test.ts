import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────
// The reconciler wires git + engine + license + brain-cache; mock each so
// the test isolates the workflow/plan decision and the merge fan-out.

const git = {
  readFile: vi.fn(),
  isMerged: vi.fn(),
}
const engine = {
  listContentBranches: vi.fn(),
  mergeBranch: vi.fn(),
}
const invalidateBrainCache = vi.fn()
let hasReviewFeature = true

vi.mock('../../server/utils/providers', () => ({
  useGitProvider: vi.fn(() => git),
  useDatabaseProvider: vi.fn(),
}))
vi.mock('../../server/utils/content-engine', () => ({
  createContentEngine: vi.fn(() => engine),
}))
vi.mock('../../server/utils/license', () => ({
  hasFeature: vi.fn(() => hasReviewFeature),
}))
vi.mock('../../server/utils/brain-cache', () => ({
  invalidateBrainCache,
}))

const { reconcileMcpCloudAutoMerge } = await import('../../server/utils/mcp-cloud-automerge')

const baseParams = {
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  installationId: 123,
  repoFullName: 'owner/repo',
  contentRoot: '',
  plan: 'pro' as never,
}

describe('reconcileMcpCloudAutoMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasReviewFeature = true
    git.readFile.mockResolvedValue(JSON.stringify({ workflow: 'auto-merge' }))
    git.isMerged.mockResolvedValue(false)
    engine.listContentBranches.mockResolvedValue([
      { name: 'cr/content/posts/en/1-aa', sha: 's1', protected: false },
    ])
    engine.mergeBranch.mockResolvedValue({ merged: true, sha: 'm', pullRequestUrl: null })
  })

  it('merges pending branches on an auto-merge project', async () => {
    await reconcileMcpCloudAutoMerge(baseParams)

    expect(engine.mergeBranch).toHaveBeenCalledWith('cr/content/posts/en/1-aa')
    expect(invalidateBrainCache).toHaveBeenCalledWith('proj-1')
  })

  it('is a no-op on a review project when the plan grants workflow.review', async () => {
    hasReviewFeature = true
    git.readFile.mockResolvedValue(JSON.stringify({ workflow: 'review' }))

    await reconcileMcpCloudAutoMerge(baseParams)

    expect(engine.mergeBranch).not.toHaveBeenCalled()
    expect(invalidateBrainCache).not.toHaveBeenCalled()
  })

  it('forces auto-merge when the plan lacks workflow.review even if config says review', async () => {
    hasReviewFeature = false
    git.readFile.mockResolvedValue(JSON.stringify({ workflow: 'review' }))

    await reconcileMcpCloudAutoMerge(baseParams)

    expect(engine.mergeBranch).toHaveBeenCalledWith('cr/content/posts/en/1-aa')
  })

  it('skips already-merged branches', async () => {
    git.isMerged.mockResolvedValue(true)

    await reconcileMcpCloudAutoMerge(baseParams)

    expect(engine.mergeBranch).not.toHaveBeenCalled()
    expect(invalidateBrainCache).not.toHaveBeenCalled()
  })

  it('defaults to auto-merge when config.json is unreadable (plan grants review)', async () => {
    git.readFile.mockRejectedValue(new Error('no config'))

    await reconcileMcpCloudAutoMerge(baseParams)

    expect(engine.mergeBranch).toHaveBeenCalled()
  })

  it('no-ops on an invalid repo full name', async () => {
    await reconcileMcpCloudAutoMerge({ ...baseParams, repoFullName: 'invalid' })

    expect(engine.listContentBranches).not.toHaveBeenCalled()
    expect(engine.mergeBranch).not.toHaveBeenCalled()
  })

  it('never throws when a merge fails (best-effort)', async () => {
    engine.mergeBranch.mockRejectedValue(new Error('merge conflict'))

    await expect(reconcileMcpCloudAutoMerge(baseParams)).resolves.toBeUndefined()
    // No successful merge → brain cache untouched.
    expect(invalidateBrainCache).not.toHaveBeenCalled()
  })
})
