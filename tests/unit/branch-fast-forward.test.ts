import { describe, expect, it } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import { createBranchGuard, finalizeContentrain, mergeToContentrain } from '../../server/utils/content-engine/branch-ops'
import { checkContentSync } from '../../server/utils/content-sync'
import type { EngineInternalContext } from '../../server/utils/content-engine/types'

/**
 * ST-8 — after a single-field save, the sync banner said "main has changes
 * your content branch does not". Production history (Collabers, 23 Sep):
 *
 *   Merge main into contentrain → save → Merge cr/… into contentrain →
 *   regenerate context.json → "Merge contentrain into main" (df82535)
 *
 * with `main` then one commit ahead of `contentrain` and both on tree a41e48f.
 * GitHub's merge API always writes a merge commit, even when the target is an
 * ancestor of the source; every advance left that commit on `main`, and the
 * next save merged it back.
 *
 * The fake below behaves like GitHub on exactly those two points: `mergeBranch`
 * always writes a merge commit (or reports "already merged"), and a
 * non-forced ref update is accepted only as a fast-forward.
 */

interface Commit { parents: string[], tree: string }

function fakeGitHub(initial: { branches: Record<string, string>, commits: Record<string, Commit> }) {
  const branches = new Map(Object.entries(initial.branches))
  const commits: Record<string, Commit> = { ...initial.commits }
  let seq = 0
  const writes: string[] = []

  const isAncestor = (a: string, b: string): boolean => {
    const stack = [b]
    const seen = new Set<string>()
    while (stack.length) {
      const c = stack.pop()!
      if (c === a) return true
      if (seen.has(c)) continue
      seen.add(c)
      stack.push(...(commits[c]?.parents ?? []))
    }
    return false
  }

  const git = {
    getDefaultBranch: async () => 'main',
    listBranches: async () => [...branches].map(([name, sha]) => ({ name, sha, protected: false })),
    getMergeBase: async (a: string, b: string) => {
      const [sa, sb] = [branches.get(a)!, branches.get(b)!]
      if (isAncestor(sa, sb)) return sa
      if (isAncestor(sb, sa)) return sb
      return 'root'
    },
    getCommitTreeSha: async (sha: string) => commits[sha]?.tree ?? null,
    async mergeBranch(from: string, into: string) {
      const [f, i] = [branches.get(from)!, branches.get(into)!]
      if (isAncestor(f, i)) return { merged: true, sha: null, pullRequestUrl: null }
      const sha = `merge-${++seq}`
      // GitHub never fast-forwards here: a new commit, even with the same tree.
      commits[sha] = { parents: [i, f], tree: isAncestor(i, f) ? commits[f]!.tree : `merged-tree-${seq}` }
      branches.set(into, sha)
      writes.push(`merge ${from}→${into}`)
      return { merged: true, sha, pullRequestUrl: null }
    },
    async fastForwardBranch(branch: string, sha: string) {
      const current = branches.get(branch)!
      if (current === sha) return true
      if (!isAncestor(current, sha)) return false
      branches.set(branch, sha)
      writes.push(`ff ${branch}`)
      return true
    },
    deleteBranch: async (name: string) => {
      branches.delete(name)
    },
  }
  return { git: git as unknown as GitProvider, branches, commits, writes }
}

const ctxOf = (git: GitProvider) => ({ git, projectId: undefined }) as unknown as EngineInternalContext

describe('advancing main to contentrain (ST-8)', () => {
  it('fast-forwards main when contentrain already contains it — no merge commit, no false banner', async () => {
    // After "Merge main into contentrain" and a save: main=A, contentrain=B (child of A).
    const gh = fakeGitHub({
      branches: { main: 'A', contentrain: 'B' },
      commits: { A: { parents: [], tree: 't-A' }, B: { parents: ['A'], tree: 't-B' } },
    })

    const result = await finalizeContentrain(ctxOf(gh.git), [])

    expect(result).toMatchObject({ merged: true, mainAdvance: 'advanced' })
    expect(gh.branches.get('main')).toBe('B')
    expect(gh.writes).toEqual(['ff main'])
    expect((await checkContentSync(gh.git)).state).toBe('in_sync')
  })

  it('when main has its own commits, merges and then levels contentrain to the merge commit', async () => {
    // A developer pushed C to main; contentrain has content B.
    const gh = fakeGitHub({
      branches: { main: 'C', contentrain: 'B' },
      commits: {
        A: { parents: [], tree: 't-A' },
        B: { parents: ['A'], tree: 't-B' },
        C: { parents: ['A'], tree: 't-C' },
      },
    })

    await finalizeContentrain(ctxOf(gh.git), [])

    expect(gh.branches.get('main')).toBe('merge-1')
    expect(gh.branches.get('contentrain')).toBe('merge-1')
    expect(gh.writes).toEqual(['merge contentrain→main', 'ff contentrain'])
    expect((await checkContentSync(gh.git)).state).toBe('in_sync')
  })

  it('the next save\'s sync writes nothing when the branches are level', async () => {
    const gh = fakeGitHub({
      branches: { main: 'B', contentrain: 'B' },
      commits: { A: { parents: [], tree: 't-A' }, B: { parents: ['A'], tree: 't-B' } },
    })

    await createBranchGuard(ctxOf(gh.git))()

    expect(gh.writes).toEqual([])
  })

  it('lands a cr/* branch on contentrain by fast-forward', async () => {
    const gh = fakeGitHub({
      branches: { 'main': 'A', 'contentrain': 'A', 'cr/content/faq/tr/1': 'S' },
      commits: { A: { parents: [], tree: 't-A' }, S: { parents: ['A'], tree: 't-S' } },
    })

    const landed = await mergeToContentrain(ctxOf(gh.git), 'cr/content/faq/tr/1')

    expect(landed).toEqual({ merged: true, sha: 'S' })
    expect(gh.branches.get('contentrain')).toBe('S')
    expect(gh.writes).toEqual(['ff contentrain'])
  })

  it('a whole save cycle leaves one linear history and the two branches level', async () => {
    // Start level, save lands on cr/*, then land + advance — the production
    // sequence that used to write two merge commits per save.
    const gh = fakeGitHub({
      branches: { 'main': 'A', 'contentrain': 'A', 'cr/save': 'S' },
      commits: { A: { parents: [], tree: 't-A' }, S: { parents: ['A'], tree: 't-S' } },
    })
    const ctx = ctxOf(gh.git)

    await createBranchGuard(ctx)()
    await mergeToContentrain(ctx, 'cr/save')
    await finalizeContentrain(ctx, [])

    expect(gh.branches.get('main')).toBe('S')
    expect(gh.branches.get('contentrain')).toBe('S')
    expect(gh.writes.filter(w => w.startsWith('merge'))).toEqual([])
    expect((await checkContentSync(gh.git)).state).toBe('in_sync')
  })
})
