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

/** The content store file Migrate commits; present on the default branch once the customer has merged the delivery. */
const CONTENT_STORE_CONFIG = '.contentrain/config.json'

export interface MigrationMergeOps {
  listBranches: (prefix?: string) => Promise<{ name: string }[]>
  readFile: (path: string, ref?: string) => Promise<string>
}

/** A read that found nothing — the file or the ref is absent. Anything else (rate limit, network, 5xx) is not an answer. */
function isMissing(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status
  if (status === 404) return true
  const message = error instanceof Error ? error.message : ''
  return /\b404\b|not found/i.test(message)
}

/**
 * The Migrate delivery branch (`migrate/<planHash>`) that has not reached the
 * default branch yet, or null. Migrate delivers into a non-empty repository on
 * a branch of its own; until the customer merges it the default branch has no
 * content store. Creating `contentrain` from that default branch now would
 * freeze it at the pre-migration tree: the project would open empty, and
 * Migrate's later "branch present" check would take that stale branch for the
 * migrated one. So connecting waits for the merge.
 *
 * Only a `migrate/…` branch that itself carries the content store counts: a
 * team's own `migrate/db-v2` branch is not a delivery and never holds a connect.
 * Only a repository with no `contentrain` branch yet is ever held.
 *
 * Fails closed: a read that errors for any reason other than "not there" throws,
 * so the caller refuses the connect instead of guessing.
 */
export async function unmergedMigrationBranch(git: MigrationMergeOps, defaultBranch: string): Promise<string | null> {
  if ((await git.listBranches(CONTENTRAIN_BRANCH)).some(branch => branch.name === CONTENTRAIN_BRANCH)) return null
  const candidates = (await git.listBranches('migrate/')).filter(branch => branch.name.startsWith('migrate/'))
  if (!candidates.length) return null
  if (await readsStore(git, defaultBranch)) return null
  for (const candidate of candidates) {
    if (await readsStore(git, candidate.name)) return candidate.name
  }
  return null
}

async function readsStore(git: MigrationMergeOps, ref: string): Promise<boolean> {
  try {
    return Boolean(await git.readFile(CONTENT_STORE_CONFIG, ref))
  }
  catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}
