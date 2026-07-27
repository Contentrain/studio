/**
 * Guarantees the `contentrain` branch exists — the content SSOT every write
 * path forks from via `applyPlan({ base: CONTENTRAIN_BRANCH })`.
 *
 * Connecting a repository used to leave it uncreated. A repo that already
 * carries `.contentrain/` on its default branch (every `contentrain-starter-*`
 * template does) is stored as `active`, so reads, `contentrain_validate` and
 * `/health` all report a perfectly valid project — while every write fails on
 * the missing base ref with a raw GitHub "get a reference" 404. The only code
 * that ever created the branch was the chat agent's `init_project`, and that
 * path never runs for a repo with nothing left to scaffold.
 *
 * Idempotent and safe to call concurrently: a lost creation race re-checks and
 * resolves to `false` rather than throwing.
 */
import { CONTENTRAIN_BRANCH } from '@contentrain/types'

/**
 * Structural, not `GitProvider` — the Studio provider calls this from inside
 * its own factory, and a nominal import would be circular.
 */
export interface ContentBranchOps {
  listBranches: (prefix?: string) => Promise<{ name: string }[]>
  createBranch: (name: string, fromRef?: string) => Promise<unknown>
  getDefaultBranch: () => Promise<string>
}

export async function ensureContentBranch(
  git: ContentBranchOps,
  defaultBranch?: string | null,
): Promise<boolean> {
  if (await branchExists(git)) return false

  const from = defaultBranch || await git.getDefaultBranch()

  try {
    await git.createBranch(CONTENTRAIN_BRANCH, from)
    return true
  }
  catch (error) {
    // Another request (or the chat agent's init) may have won the race —
    // GitHub answers 422 for an existing ref. Only a genuine failure rethrows.
    if (await branchExists(git)) return false
    throw error
  }
}

async function branchExists(git: ContentBranchOps): Promise<boolean> {
  const matches = await git.listBranches(CONTENTRAIN_BRANCH)
  return matches.some(branch => branch.name === CONTENTRAIN_BRANCH)
}
