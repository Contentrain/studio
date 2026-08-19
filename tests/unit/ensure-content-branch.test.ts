import { describe, expect, it, vi } from 'vitest'
import { ensureContentBranch } from '../../server/utils/ensure-content-branch'

function ops(overrides: Partial<{
  branches: { name: string }[][]
  createBranch: () => Promise<unknown>
  defaultBranch: string
}> = {}) {
  const pages = overrides.branches ?? [[]]
  let call = 0
  const listBranches = vi.fn(async () => pages[Math.min(call++, pages.length - 1)]!)
  const createBranch = vi.fn(overrides.createBranch ?? (async () => undefined))
  const getDefaultBranch = vi.fn(async () => overrides.defaultBranch ?? 'main')
  return { listBranches, createBranch, getDefaultBranch }
}

describe('ensureContentBranch', () => {
  it('creates the branch from the supplied default when it is missing', async () => {
    const git = ops()
    await expect(ensureContentBranch(git, 'trunk')).resolves.toBe(true)
    expect(git.createBranch).toHaveBeenCalledWith('contentrain', 'trunk')
    // The caller already knows the default branch — do not spend an API call.
    expect(git.getDefaultBranch).not.toHaveBeenCalled()
  })

  it('falls back to the repository default branch when none is supplied', async () => {
    const git = ops({ defaultBranch: 'master' })
    await ensureContentBranch(git)
    expect(git.createBranch).toHaveBeenCalledWith('contentrain', 'master')
  })

  it('is a no-op when the branch already exists', async () => {
    const git = ops({ branches: [[{ name: 'contentrain' }]] })
    await expect(ensureContentBranch(git, 'main')).resolves.toBe(false)
    expect(git.createBranch).not.toHaveBeenCalled()
  })

  it('ignores a prefix match that is not the branch itself', async () => {
    const git = ops({ branches: [[{ name: 'contentrain-legacy' }]] })
    await expect(ensureContentBranch(git, 'main')).resolves.toBe(true)
    expect(git.createBranch).toHaveBeenCalledOnce()
  })

  it('resolves to false when a concurrent creation won the race', async () => {
    const git = ops({
      branches: [[], [{ name: 'contentrain' }]],
      createBranch: async () => { throw new Error('Reference already exists') },
    })
    await expect(ensureContentBranch(git, 'main')).resolves.toBe(false)
  })

  it('rethrows when creation genuinely failed', async () => {
    const git = ops({
      branches: [[], []],
      createBranch: async () => { throw new Error('Resource not accessible by integration') },
    })
    await expect(ensureContentBranch(git, 'main')).rejects.toThrow('Resource not accessible')
  })
})
