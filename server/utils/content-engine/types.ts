import type { ValidationResult } from '@contentrain/types'
import type { GitProvider, Commit, CommitAuthor, Branch, FileDiff, MergeResult } from '../../providers/git'

// ── Public types (re-exported from index.ts) ────────────────────────

export interface WriteResult {
  branch: string
  commit: Commit
  diff: FileDiff[]
  validation: ValidationResult
}

export interface ContentEngineContext {
  git: GitProvider
  contentRoot: string
}

// ── Internal shared context (passed to each operation function) ──────

export interface EngineInternalContext {
  git: GitProvider
  pathCtx: { contentRoot: string }
  ensureContentBranch: () => Promise<void>
  getProjectInfo: (fallbackLocale: string) => Promise<{ modelCount: number, locales: string[] }>
}

// ── Constants ────────────────────────────────────────────────────────

export const BOT_AUTHOR: CommitAuthor = {
  name: 'Contentrain Studio[bot]',
  email: 'bot@contentrain.io',
}

/** Content branch name — dedicated SSOT branch per git-architecture.md */
export const CONTENT_BRANCH = 'contentrain'

/** Branch prefix for feature branches — avoids ref collision with CONTENT_BRANCH */
export const BRANCH_PREFIX = 'cr/'

// ── Re-export provider types used by operations ─────────────────────

export type { GitProvider, Commit, CommitAuthor, Branch, FileDiff, MergeResult }
