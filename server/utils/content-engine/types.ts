import type { ValidationResult } from '@contentrain/types'
import type { Branch, Commit, CommitAuthor, FileDiff, GitProvider, MergeResult } from '../../providers/git'

// ── Public types (re-exported from index.ts) ────────────────────────

/**
 * Scheduling a write may carry. Three states per key: a string sets the
 * date, `null` clears it, an absent key leaves whatever meta holds alone.
 *
 * Scheduling is meta and only meta (MCP 3.1.8). It never reaches the
 * content file, and it never changes `status`: a `publish_at` in the past
 * does not publish a draft. Delivery treats the dates as a gate on top of
 * `status: published` — `cdn-builder.ts` serves a published entry once
 * `publish_at` has passed and until `expire_at`. Publishing stays a
 * deliberate `updateEntryStatus`.
 */
export interface EntrySchedule {
  publish_at?: string | null
  expire_at?: string | null
}

export interface SaveOptions {
  autoPublish?: boolean
  /** Applied to every entry this save touches; a date inside an entry's own data wins. */
  schedule?: EntrySchedule
}

export interface WriteResult {
  branch: string
  commit: Commit
  diff: FileDiff[]
  validation: ValidationResult
  /**
   * The planned files were byte-identical to `contentrain` — no branch,
   * commit, or merge was performed. Not a failure: the requested state was
   * already live.
   */
  unchanged?: boolean
  /**
   * Locale-agnostic fields (media, relations) this save also wrote into the
   * model's other locales, and which locales those were. Absent when the
   * save touched only the addressed locale.
   */
  sharedAcrossLocales?: { fields: string[], locales: string[] }
}

/** One entry's publish-status transition. `from` is `null` if it had no meta. */
export interface StatusChange {
  entryId: string
  from: string | null
  to: string
}

/**
 * `updateEntryStatus` result. Carries the before/after status of every entry
 * the call named — including the ones it deliberately left alone — so the
 * caller can never mistake "already published" for "I published it".
 */
export interface StatusWriteResult extends WriteResult {
  statusChanges: StatusChange[]
}

/**
 * Outcome of the `contentrain → main` advance. The vocabulary is shared with
 * the MCP-side R0 contract (AI-REPO-RECONCILE feedback, N3) so the two
 * ecosystems name the same states the same way:
 *
 * - `advanced` — main now carries the content (includes "already up to date").
 * - `blocked_diverged` — main has commits contentrain does not; the advance
 *   cannot fast-forward. A PR carries the state instead: it is an attachment
 *   (`pullRequestUrl`), not a separate status.
 */
export type MainAdvance = 'advanced' | 'blocked_diverged'

/**
 * What a merge actually did, told truthfully.
 *
 * `merged` answers the question the caller is really asking — did the content
 * land on `contentrain`, the SSOT every reader uses. The advance to `main` is
 * a separate fact (`mainAdvance`): reporting its failure as "the merge failed"
 * is what made an Approve on a diverged repo read as a lost save when nothing
 * was lost.
 */
export interface EngineMergeResult extends MergeResult {
  mainAdvance?: MainAdvance
}

export interface ContentEngineContext {
  git: GitProvider
  contentRoot: string
  projectId?: string
}

// ── Internal shared context (passed to each operation function) ──────

export interface EngineInternalContext {
  git: GitProvider
  pathCtx: { contentRoot: string }
  projectId?: string
  ensureContentBranch: () => Promise<void>
}

// ── Constants ────────────────────────────────────────────────────────

export const STUDIO_AUTHOR: CommitAuthor = {
  name: 'Contentrain Studio',
  email: 'ai@contentrain.io',
}

/** Content branch name — dedicated SSOT branch per git-architecture.md */
export const CONTENT_BRANCH = 'contentrain'

/** Branch prefix for feature branches — avoids ref collision with CONTENT_BRANCH */
export const BRANCH_PREFIX = 'cr/'

// ── Re-export provider types used by operations ─────────────────────

export type { Branch, Commit, CommitAuthor, FileDiff, GitProvider, MergeResult }
