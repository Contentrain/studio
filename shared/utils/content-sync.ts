/**
 * Where the content branch stands against the repository's own branch, as the
 * endpoint returns it and the sidebar renders it.
 *
 * Shared because the four states are a vocabulary, not an implementation
 * detail: the panel has to say the same thing about `base_ahead` that the
 * engine means by it.
 */

export type ContentSyncState = 'in_sync' | 'content_ahead' | 'base_ahead' | 'diverged' | 'unknown'

export interface ContentSyncReport {
  state: ContentSyncState
  contentBranch: string
  baseBranch: string
  contentSha: string | null
  baseSha: string | null
  /** True only for `base_ahead`: syncing is a fast-forward, with nothing to decide. */
  fastForward: boolean
  /**
   * The open pull request that carries the content branch into the base one,
   * when there is one. Its presence means the advance is waiting on a person —
   * the base branch is protected or has diverged — so approved content is not
   * on the site's branch until it is merged. Absent on readings cached before
   * the field existed.
   */
  advancePullRequestUrl?: string | null
  checkedAt: string
}

/**
 * States worth a line in the UI.
 *
 * `in_sync` is the expected state and saying so every time trains people to
 * stop reading the row. `unknown` earns its place: it means Studio could not
 * tell, which is different from telling someone everything is fine.
 */
export function isSyncNoteworthy(report: ContentSyncReport | null | undefined): boolean {
  return !!report && report.state !== 'in_sync'
}
