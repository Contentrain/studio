import { describe, expect, it, vi } from 'vitest'
import { ensureContentBranch, unmergedMigrationBranch } from '../../server/utils/ensure-content-branch'

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

describe('unmergedMigrationBranch', () => {
  /** `stores`: refs whose `.contentrain/config.json` reads; a ref in `broken` fails with a transient error. */
  const git = (opts: { branches?: string[], stores?: string[], broken?: string[] }) => ({
    listBranches: vi.fn(async (prefix?: string) =>
      (opts.branches ?? []).filter(name => !prefix || name.startsWith(prefix)).map(name => ({ name }))),
    readFile: vi.fn(async (_path: string, ref?: string) => {
      if (opts.broken?.includes(ref ?? '')) throw Object.assign(new Error('rate limited'), { status: 403 })
      if (!opts.stores?.includes(ref ?? '')) throw Object.assign(new Error('Not Found'), { status: 404 })
      return '{}'
    }),
  })

  it('holds the connect while a delivery branch (it carries the store) is unmerged and no content branch exists', async () => {
    await expect(unmergedMigrationBranch(git({ branches: ['main', 'migrate/abc123'], stores: ['migrate/abc123'] }), 'main')).resolves.toBe('migrate/abc123')
  })

  it('does not hold on a team\'s own migrate/ branch: it carries no content store', async () => {
    await expect(unmergedMigrationBranch(git({ branches: ['main', 'migrate/db-v2'] }), 'main')).resolves.toBeNull()
  })

  it('lets it through once the default branch carries the content store', async () => {
    await expect(unmergedMigrationBranch(git({ branches: ['main', 'migrate/abc123'], stores: ['main', 'migrate/abc123'] }), 'main')).resolves.toBeNull()
  })

  it('does not hold a repository that already has a contentrain branch', async () => {
    await expect(unmergedMigrationBranch(git({ branches: ['contentrain', 'migrate/abc123'], stores: ['migrate/abc123'] }), 'main')).resolves.toBeNull()
  })

  it('does not touch an ordinary repository (no migrate/ branch)', async () => {
    const ops = git({ branches: ['main'] })
    await expect(unmergedMigrationBranch(ops, 'main')).resolves.toBeNull()
    expect(ops.readFile).not.toHaveBeenCalled()
  })

  it('fails closed: a transient read error is thrown, not read as "no delivery"', async () => {
    await expect(unmergedMigrationBranch(git({ branches: ['main', 'migrate/abc123'], stores: ['migrate/abc123'], broken: ['main'] }), 'main')).rejects.toThrow('rate limited')
    await expect(unmergedMigrationBranch(git({ branches: ['main', 'migrate/abc123'], broken: ['migrate/abc123'] }), 'main')).rejects.toThrow('rate limited')
  })
})
