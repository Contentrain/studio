import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import { checkContentSync, invalidateContentSync, readContentSync } from '../../server/utils/content-sync'

/**
 * The four states, derived from branch tips and a merge base — the two
 * primitives every provider has to have. Pinned because the vocabulary is what
 * the UI, the health endpoint and the engine all have to agree on, and because
 * the interesting half is what Studio refuses to claim: `unknown` where it
 * cannot tell, rather than the reassuring answer.
 */

function git(over: Partial<GitProvider> = {}): GitProvider {
  return {
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    listBranches: vi.fn().mockResolvedValue([
      { name: 'contentrain', sha: 'content-sha', protected: false },
      { name: 'main', sha: 'base-sha', protected: false },
    ]),
    getMergeBase: vi.fn().mockResolvedValue('base-sha'),
    ...over,
  } as unknown as GitProvider
}

describe('content sync', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('useRuntimeConfig', () => ({ redis: {} }))
  })

  it('reads the branches as the same commit as in sync', async () => {
    const report = await checkContentSync(git({
      listBranches: vi.fn().mockResolvedValue([
        { name: 'contentrain', sha: 'same', protected: false },
        { name: 'main', sha: 'same', protected: false },
      ]),
    }))
    expect(report.state).toBe('in_sync')
    expect(report.fastForward).toBe(false)
  })

  it('calls content ahead when the base branch is the merge base', async () => {
    // The ordinary transient state: the advance runs at the end of a turn, so
    // a read taken mid-turn lands here and resolves itself.
    const report = await checkContentSync(git({ getMergeBase: vi.fn().mockResolvedValue('base-sha') }))
    expect(report.state).toBe('content_ahead')
    expect(report.fastForward).toBe(false)
  })

  it('calls base ahead a fast-forward, and only that state', async () => {
    // The one state where syncing is mechanical — nothing to reconcile,
    // nothing to decide.
    const report = await checkContentSync(git({ getMergeBase: vi.fn().mockResolvedValue('content-sha') }))
    expect(report.state).toBe('base_ahead')
    expect(report.fastForward).toBe(true)
  })

  it('calls a base tip with the same tree in sync — a merge commit is not a change (ST-8)', async () => {
    // What GitHub's merge API left after every advance: main one commit
    // ahead of contentrain, both commits pointing at the same tree.
    const report = await checkContentSync(git({
      getMergeBase: vi.fn().mockResolvedValue('content-sha'),
      getCommitTreeSha: vi.fn().mockResolvedValue('tree-a41e48f'),
    }))
    expect(report.state).toBe('in_sync')
  })

  it('still calls base ahead when the trees differ', async () => {
    const trees: Record<string, string> = { 'content-sha': 'tree-1', 'base-sha': 'tree-2' }
    const report = await checkContentSync(git({
      getMergeBase: vi.fn().mockResolvedValue('content-sha'),
      getCommitTreeSha: vi.fn(async (sha: string) => trees[sha] ?? null),
    }))
    expect(report.state).toBe('base_ahead')
  })

  it('calls it diverged when neither tip is the merge base', async () => {
    const report = await checkContentSync(git({ getMergeBase: vi.fn().mockResolvedValue('older-sha') }))
    expect(report.state).toBe('diverged')
    expect(report.fastForward).toBe(false)
  })

  it('says unknown rather than guessing', async () => {
    // A provider without the optional merge-base capability…
    const noCapability = await checkContentSync(git({ getMergeBase: undefined }))
    expect(noCapability.state).toBe('unknown')

    // …no common history…
    const noHistory = await checkContentSync(git({ getMergeBase: vi.fn().mockResolvedValue(null) }))
    expect(noHistory.state).toBe('unknown')

    // …and a project whose content branch does not exist yet, which is not the
    // same fact as "the branches agree".
    const noBranch = await checkContentSync(git({
      listBranches: vi.fn().mockResolvedValue([{ name: 'main', sha: 'base-sha', protected: false }]),
    }))
    expect(noBranch.state).toBe('unknown')
    expect(noBranch.contentSha).toBeNull()

    // …and a repo it cannot list at all.
    const unreadable = await checkContentSync(git({ listBranches: vi.fn().mockRejectedValue(new Error('403')) }))
    expect(unreadable.state).toBe('unknown')
  })

  it('names the repository\'s own default branch rather than assuming main', async () => {
    const report = await checkContentSync(git({
      getDefaultBranch: vi.fn().mockResolvedValue('master'),
      listBranches: vi.fn().mockResolvedValue([
        { name: 'contentrain', sha: 'content-sha', protected: false },
        { name: 'master', sha: 'base-sha', protected: false },
      ]),
    }))
    expect(report.baseBranch).toBe('master')
    expect(report.state).toBe('content_ahead')
  })

  it('serves the reading from cache until something says it changed', async () => {
    // The TTL is the floor. Without invalidation the state is right eventually,
    // which is not the same as being right when someone looks — so a merge and
    // a push webhook both drop it.
    const listBranches = vi.fn().mockResolvedValue([
      { name: 'contentrain', sha: 'same', protected: false },
      { name: 'main', sha: 'same', protected: false },
    ])
    const provider = git({ listBranches })

    await readContentSync(provider, 'project-cache')
    await readContentSync(provider, 'project-cache')
    expect(listBranches).toHaveBeenCalledTimes(1)

    await invalidateContentSync('project-cache')
    await readContentSync(provider, 'project-cache')
    expect(listBranches).toHaveBeenCalledTimes(2)
  })

  it('keeps one project\'s reading out of another\'s', async () => {
    const listBranches = vi.fn().mockResolvedValue([
      { name: 'contentrain', sha: 'same', protected: false },
      { name: 'main', sha: 'same', protected: false },
    ])
    const provider = git({ listBranches })
    await readContentSync(provider, 'project-a')
    await readContentSync(provider, 'project-b')
    expect(listBranches).toHaveBeenCalledTimes(2)
  })
})
