import { describe, expect, it, vi } from 'vitest'
import { planReconcile } from '@contentrain/mcp/core/ops'
import { createContentEngine } from '../../server/utils/content-engine'
import type { GitProvider } from '../../server/providers/git'

/**
 * The reconcile binding: when the contentrain → main advance hits a conflict,
 * `finalizeContentrain` tries mcp 3.1.0's content-aware three-way merge before
 * falling back to a PR. The planner itself has its own suite in the mcp repo —
 * here it is mocked, because what Studio owns is the ORCHESTRATION: when the
 * reconcile runs, what goes into the merge commit, and when the PR remains
 * the honest answer.
 */
vi.mock('@contentrain/mcp/core/ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@contentrain/mcp/core/ops')>()
  return { ...actual, planReconcile: vi.fn() }
})

const mockedPlanReconcile = vi.mocked(planReconcile)

const commit = {
  sha: 'merge-commit-sha',
  message: 'reconcile',
  author: { name: 'bot', email: 'bot@example.com' },
  timestamp: '2026-08-15T00:00:00.000Z',
}

const OURS_SHA = 'ours-sha'
const THEIRS_SHA = 'theirs-sha'

/** Trees for the collabers shape: content changed on ours, code on theirs. */
const OURS_TREE = [
  { path: '.contentrain/models/articles.json', sha: 'model-old', type: 'blob' },
  { path: '.contentrain/content/blog/articles/en.json', sha: 'content-ours', type: 'blob' },
  { path: 'src/app.ts', sha: 'app-old', type: 'blob' },
  { path: 'package.json', sha: 'pkg-old', type: 'blob' },
  { path: 'assets/logo.png', sha: 'logo-same', type: 'blob' },
  { path: 'src/removed-on-main.ts', sha: 'gone', type: 'blob' },
]
const THEIRS_TREE = [
  // Content-owned, differs, but the planner emitted no change for it —
  // meaning the merged result equals ours. Composing theirs here would
  // overrule the policy table.
  { path: '.contentrain/models/articles.json', sha: 'model-new', type: 'blob' },
  { path: '.contentrain/content/blog/articles/en.json', sha: 'content-ours', type: 'blob' },
  // The migration commit's code — the Appendix C trap.
  { path: 'src/app.ts', sha: 'app-new', type: 'blob' },
  { path: 'package.json', sha: 'pkg-new', type: 'blob' },
  { path: 'assets/logo.png', sha: 'logo-same', type: 'blob' },
  // src/removed-on-main.ts absent — deleted on main.
]

const PLAN_CHANGES = [
  { path: '.contentrain/content/blog/articles/en.json', content: '{"merged":true}' },
  { path: '.contentrain/context.json', content: '{"regenerated":true}' },
]

function createGit(overrides: Partial<Record<keyof GitProvider, unknown>> = {}): GitProvider {
  return {
    readFile: vi.fn(async (path: string, ref?: string) => `content-of:${path}@${ref}`),
    listDirectory: vi.fn().mockResolvedValue([]),
    fileExists: vi.fn().mockResolvedValue(false),
    getTree: vi.fn(async (ref?: string) => (ref === THEIRS_SHA ? THEIRS_TREE : OURS_TREE)),
    listBranches: vi.fn().mockResolvedValue([
      { name: 'contentrain', sha: OURS_SHA, protected: false },
      { name: 'main', sha: THEIRS_SHA, protected: false },
    ]),
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
    getBranchDiff: vi.fn().mockResolvedValue([]),
    // The advance: first attempt conflicts (that is what brings us here),
    // the post-reconcile attempt fast-forwards.
    mergeBranch: vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Merge conflict'), { status: 409 }))
      .mockResolvedValueOnce({ merged: true, sha: 'ff-sha', pullRequestUrl: null }),
    applyPlan: vi.fn().mockResolvedValue(commit),
    commitFiles: vi.fn(),
    createPR: vi.fn().mockResolvedValue({ id: 'pr-1', url: 'https://example.com/pr/1' }),
    mergePR: vi.fn(),
    getPermissions: vi.fn(),
    getBranchProtection: vi.fn(),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    detectFramework: vi.fn(),
    isMerged: vi.fn().mockResolvedValue(false),
    getMergeBase: vi.fn().mockResolvedValue('base-sha'),
    createMergeCommit: vi.fn().mockResolvedValue(commit),
    ...overrides,
  } as unknown as GitProvider
}

describe('reconcile binding in finalizeContentrain', () => {
  it('heals a mechanical divergence in-line: merge commit + fast-forward advance', async () => {
    mockedPlanReconcile.mockResolvedValue({ changes: PLAN_CHANGES, conflicts: [], result: {} } as never)
    const git = createGit()
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.finalizeContentrain(['cr/content/articles/tr/1786700000-aaaa'])

    // No PR, no blocked state — the divergence resolved without a human.
    expect(result).toMatchObject({ merged: true, mainAdvance: 'advanced' })
    expect(git.createPR).not.toHaveBeenCalled()

    const input = (git.createMergeCommit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      branch: string
      ours: string
      theirs: string
      changes: Array<{ path: string, content: string | null }>
    }
    expect(input).toMatchObject({ branch: 'contentrain', ours: OURS_SHA, theirs: THEIRS_SHA })

    const byPath = new Map(input.changes.map(c => [c.path, c.content]))
    // Planner output rides in untouched.
    expect(byPath.get('.contentrain/content/blog/articles/en.json')).toBe('{"merged":true}')
    // THE TRAP (Appendix C): theirs-only code changes must be composed in,
    // or fast-forwarding main to this commit erases main's own migration.
    expect(byPath.get('src/app.ts')).toBe(`content-of:src/app.ts@${THEIRS_SHA}`)
    expect(byPath.get('package.json')).toBe(`content-of:package.json@${THEIRS_SHA}`)
    // A file main deleted stays deleted.
    expect(byPath.get('src/removed-on-main.ts')).toBeNull()
    // An unchanged blob is not touched…
    expect(byPath.has('assets/logo.png')).toBe(false)
    // …and neither is a content-owned path the planner decided to leave as
    // ours — composing theirs for it would overrule the policy table.
    expect(byPath.has('.contentrain/models/articles.json')).toBe(false)
  })

  it('leaves surviving conflicts to the PR, never to createMergeCommit', async () => {
    mockedPlanReconcile.mockResolvedValue({
      changes: PLAN_CHANGES,
      conflicts: [{ id: 'c1', path: '.contentrain/vocabulary.json', kind: 'vocabulary', code: 'vocabulary_value_conflict', message: 'both sides changed "brand" (tr)' }],
      result: {},
    } as never)
    const git = createGit()
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.finalizeContentrain(['cr/content/articles/tr/1786700000-aaaa'])

    expect(git.createMergeCommit).not.toHaveBeenCalled()
    expect(result).toMatchObject({ merged: true, mainAdvance: 'blocked_diverged', pullRequestUrl: 'https://example.com/pr/1' })
  })

  it('goes straight to the PR when the provider lacks the capability', async () => {
    const git = createGit({ getMergeBase: undefined, createMergeCommit: undefined })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.finalizeContentrain(['cr/content/articles/tr/1786700000-aaaa'])

    expect(mockedPlanReconcile).not.toHaveBeenCalled()
    expect(result).toMatchObject({ merged: true, mainAdvance: 'blocked_diverged' })
  })

  it('bails to the PR rather than compose a binary through a string round-trip', async () => {
    mockedPlanReconcile.mockResolvedValue({ changes: PLAN_CHANGES, conflicts: [], result: {} } as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const git = createGit({
      getTree: vi.fn(async (ref?: string) => (ref === THEIRS_SHA
        ? [...THEIRS_TREE.filter(e => e.path !== 'assets/logo.png'), { path: 'assets/logo.png', sha: 'logo-CHANGED', type: 'blob' }]
        : OURS_TREE)),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.finalizeContentrain(['cr/content/articles/tr/1786700000-aaaa'])

    // Corrupting an image would be worse than an annoying PR.
    expect(git.createMergeCommit).not.toHaveBeenCalled()
    expect(result).toMatchObject({ merged: true, mainAdvance: 'blocked_diverged' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('logo.png'))
    warn.mockRestore()
  })

  it('falls back to the PR when the branch moved mid-reconcile (stale ours)', async () => {
    mockedPlanReconcile.mockResolvedValue({ changes: PLAN_CHANGES, conflicts: [], result: {} } as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const git = createGit({
      createMergeCommit: vi.fn().mockRejectedValue(Object.assign(
        new Error('createMergeCommit: "contentrain" is at 12345678, not the expected 87654321 — the branch moved since planning.'),
        { code: 'RECONCILE_STALE_OURS' },
      )),
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.finalizeContentrain(['cr/content/articles/tr/1786700000-aaaa'])

    // Not a 500 — the next approve replans against the new tip; meanwhile the
    // PR keeps the state visible.
    expect(result).toMatchObject({ merged: true, mainAdvance: 'blocked_diverged' })
    warn.mockRestore()
  })
})
