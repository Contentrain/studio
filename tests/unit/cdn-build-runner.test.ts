import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import type { CDNProvider } from '../../server/providers/cdn'
import type { DatabaseProvider } from '../../server/providers/database'
import type { BuildResult } from '../../server/utils/cdn-builder'
import { executeCDNBuild } from '../../server/utils/cdn-builder'
import { runCDNBuild } from '../../server/utils/cdn-build-runner'

// The runner delegates the actual build to executeCDNBuild; stub it so these
// tests exercise only the orchestration (status persistence + catch-up).
vi.mock('../../server/utils/cdn-builder', () => ({ executeCDNBuild: vi.fn() }))

const mockedExecute = vi.mocked(executeCDNBuild)

function ok(overrides: Partial<BuildResult> = {}): BuildResult {
  return {
    projectId: 'p',
    buildId: 'b',
    commitSha: 's',
    filesUploaded: 3,
    filesDeleted: 0,
    totalSizeBytes: 100,
    changedModels: ['faq'],
    durationMs: 10,
    ...overrides,
  }
}

function makeDeps(headSequence: string[]) {
  const listBranches = vi.fn()
  for (const sha of headSequence)
    listBranches.mockResolvedValueOnce([{ name: 'main', sha }])
  // Any extra calls resolve to the last head (stable).
  listBranches.mockResolvedValue([{ name: 'main', sha: headSequence.at(-1) }])

  const git = { listBranches } as unknown as GitProvider
  const cdn = {} as CDNProvider
  const createCDNBuild = vi.fn().mockResolvedValue({ id: 'catchup-build' })
  const updateCDNBuild = vi.fn().mockResolvedValue(undefined)
  const db = { createCDNBuild, updateCDNBuild } as unknown as DatabaseProvider
  return { git, cdn, db, createCDNBuild, updateCDNBuild, listBranches }
}

const base = { contentRoot: '', branch: 'main' as const }

describe('runCDNBuild', () => {
  beforeEach(() => mockedExecute.mockReset())

  it('persists the result and does not catch up when the branch head is unchanged', async () => {
    mockedExecute.mockResolvedValueOnce(ok())
    const { db, git, cdn, createCDNBuild, updateCDNBuild } = makeDeps(['sha1'])

    await runCDNBuild({ db, projectId: 'p', buildId: 'b', git, cdn, commitSha: 'sha1', ...base })

    expect(mockedExecute).toHaveBeenCalledTimes(1)
    expect(updateCDNBuild).toHaveBeenCalledWith('b', expect.objectContaining({ status: 'success', file_count: 3 }))
    // Head equals the built commit → nothing stranded → no follow-up.
    expect(createCDNBuild).not.toHaveBeenCalled()
  })

  it('chases a mid-build push: rebuilds at the new head, then stops when it stabilizes', async () => {
    mockedExecute.mockResolvedValue(ok())
    // Head advanced to sha2 during the initial build; after rebuilding sha2 it is stable.
    const { db, git, cdn, createCDNBuild } = makeDeps(['sha2', 'sha2'])

    await runCDNBuild({ db, projectId: 'p', buildId: 'b', git, cdn, commitSha: 'sha1', ...base })

    // Initial build + one catch-up build.
    expect(mockedExecute).toHaveBeenCalledTimes(2)
    expect(createCDNBuild).toHaveBeenCalledTimes(1)
    expect(createCDNBuild).toHaveBeenCalledWith(expect.objectContaining({ commitSha: 'sha2', triggerType: 'webhook' }))
    // Catch-up builds are full rebuilds (always correct under serialization).
    expect(mockedExecute).toHaveBeenLastCalledWith(expect.objectContaining({ commitSha: 'sha2', fullRebuild: true }))
  })

  it('stops the catch-up when the follow-up claim is blocked (null)', async () => {
    mockedExecute.mockResolvedValue(ok())
    const { db, git, cdn, createCDNBuild } = makeDeps(['sha2'])
    // Another build already holds the in-flight slot.
    vi.mocked(createCDNBuild).mockResolvedValue(null)

    await runCDNBuild({ db, projectId: 'p', buildId: 'b', git, cdn, commitSha: 'sha1', ...base })

    expect(createCDNBuild).toHaveBeenCalledTimes(1)
    // No second executeCDNBuild — the slot holder will chase the head.
    expect(mockedExecute).toHaveBeenCalledTimes(1)
  })

  it('does not catch up after a failed build', async () => {
    mockedExecute.mockResolvedValueOnce(ok({ error: 'boom' }))
    const { db, git, cdn, createCDNBuild, updateCDNBuild, listBranches } = makeDeps(['sha2'])

    await runCDNBuild({ db, projectId: 'p', buildId: 'b', git, cdn, commitSha: 'sha1', ...base })

    expect(updateCDNBuild).toHaveBeenCalledWith('b', expect.objectContaining({ status: 'failed', error_message: 'boom' }))
    expect(listBranches).not.toHaveBeenCalled()
    expect(createCDNBuild).not.toHaveBeenCalled()
  })
})
