/**
 * Studio Git Provider — a `RepoProvider` (from `@contentrain/mcp` via
 * `@contentrain/types`) extended with Studio-specific operations that
 * live outside MCP's commodity surface: tree listing for brain-cache,
 * framework detection for project setup, PR helpers for branch-protected
 * merges, permission / protection introspection for UI state.
 *
 * Commodity content operations (`readFile`, `applyPlan`, `listBranches`,
 * ...) are provided by the wrapped MCP `GitHubProvider`. Studio-side
 * extensions reuse the same Octokit client so auth, rate-limit and retry
 * semantics stay consistent.
 *
 * See `.internal/refactor/02-studio-handoff.md` — Faz S1 for context.
 */

import { GitHubProvider } from '@contentrain/mcp/providers/github'
import type {
  ApplyPlanInput,
  Commit,
  CommitAuthor,
  FileChange,
  MediaProvider as ContractMediaProvider,
  RepoProvider,
} from '@contentrain/types'
import { createGitHubExtensions, createInstallationOctokit } from './github-app'

// ─── RepoProvider contracts (re-exported from @contentrain/types) ───

export type {
  ApplyPlanInput,
  Branch,
  Commit,
  CommitAuthor,
  FileChange,
  FileDiff,
  MergeResult,
  ProviderCapabilities,
  RepoProvider,
  RepoReader,
  RepoWriter,
} from '@contentrain/types'

// ─── Studio-specific types (no MCP equivalent) ───

export interface TreeEntry {
  path: string
  type: 'blob' | 'tree'
  sha: string
  size?: number
}

export interface BranchProtection {
  requiredReviews: number
  requirePR: boolean
}

export interface RepoPermissions {
  push: boolean
  pull: boolean
  admin: boolean
}

export interface FrameworkDetection {
  stack: string
  hasContentDir: boolean
  hasI18n: boolean
  suggestedContentPaths: Record<string, string>
}

// ─── GitHub App installation-scoped types (preserved) ───

export interface InstallationAccount {
  login: string | null
  avatarUrl: string | null
  type: string | null
}

export interface InstallationRepository {
  id: number
  name: string
  fullName: string
  owner: string
  private: boolean
  defaultBranch?: string | null
  description?: string | null
  language?: string | null
  updatedAt?: string | null
  htmlUrl?: string | null
}

export interface InstallationDetails {
  installationId: number
  account: InstallationAccount
  selection: string | null
  permissions: Record<string, string> | null
  suspendedAt: string | null
}

export interface TemplateRepositoryInput {
  templateOwner: string
  templateRepo: string
  name: string
  private?: boolean
  description?: string
}

export interface GitAppProvider {
  getInstallationDetails: () => Promise<InstallationDetails>
  listInstallationRepositories: () => Promise<InstallationRepository[]>
  createRepositoryFromTemplate: (input: TemplateRepositoryInput) => Promise<InstallationRepository>
  canAccessRepository: (owner: string, repo: string) => Promise<boolean>
  /**
   * Revoke (uninstall) the GitHub App from the account/org this
   * installation is bound to. Auth context: App JWT (not the
   * installation token). Returns true on success, false if GitHub
   * returned 404 (installation already gone — idempotent success).
   * Other errors propagate so callers can decide whether to swallow.
   */
  revokeInstallation: () => Promise<boolean>
}

/**
 * Summary of a GitHub App installation as seen from a user's
 * perspective (via `GET /user/installations`). Note this is a
 * different shape from `InstallationDetails` (which is the App-JWT
 * view of a single installation) — the user-scoped listing returns
 * less metadata and includes `app_id` so the caller can filter to
 * the Studio App's installations only.
 */
export interface UserInstallationSummary {
  id: number
  appId: number
  account: InstallationAccount
  repositorySelection: 'all' | 'selected' | null
  targetType: 'User' | 'Organization' | string | null
}

/**
 * App-level GitHub operations that are NOT scoped to a single
 * installation. Uses an App JWT for App-administration calls and the
 * user's OAuth access token for user-scoped calls — neither requires
 * an installation_id at construction time, so this is intentionally
 * separated from `GitAppProvider` (which is installation-scoped).
 */
export interface GitAppService {
  /**
   * Enumerate installations the authenticated user can see.
   * `userAccessToken` is the GitHub user-to-server OAuth token (`gho_*`
   * for legacy OAuth Apps, `ghu_*` for GitHub Apps with expiring
   * user tokens). Result is filtered to the configured Studio App ID.
   */
  listInstallationsForUser: (userAccessToken: string) => Promise<UserInstallationSummary[]>

  /**
   * Verify that the authenticated user has access to a specific
   * installation. Returns true when GitHub returns 200 on
   * `GET /user/installations/{id}/repositories?per_page=1`, false on
   * 404. Used at attach time to prevent installation_id parameter
   * spoofing (a user could otherwise attach an installation they
   * have no GitHub-side access to, modulo the in-app 409 collision
   * check). Pattern adapted from PostHog's
   * `verify_user_installation_access` (MIT-licensed).
   */
  verifyUserHasAccessToInstallation: (
    userAccessToken: string,
    installationId: number,
  ) => Promise<boolean>
}

// ─── GitProvider: RepoProvider + Studio extensions ───

export interface GitProvider extends RepoProvider {
  /**
   * Per-project public media delivery base (`{siteUrl}/api/cdn/v1/{projectId}`),
   * set only for MCP Cloud loopback providers. The MCP content-write path reads
   * it to normalize `media/...` references to the same absolute delivery URLs
   * Studio's own write path produces, so external-agent writes render anywhere.
   * Undefined for local/CLI providers (no CDN), where media stays a path.
   */
  mediaBaseUrl?: string

  /** Full repo tree in one call. Used by brain-cache for SHA-level change detection. */
  getTree: (ref?: string) => Promise<TreeEntry[]>

  /**
   * Studio-side commit helper — delegates to `applyPlan` with the
   * legacy signature preserved. Kept as a backward-compatibility shim
   * so existing content-engine callers compile unchanged; Faz S2
   * migrates callers to `applyPlan` directly and this member is
   * removed once unused.
   */
  commitFiles: (branch: string, files: FileChange[], message: string, author: CommitAuthor) => Promise<Commit>

  /** Open a PR — merge fallback when direct merge is blocked by branch protection. */
  createPR: (head: string, base: string, title: string, body: string) => Promise<{ id: string, url: string }>
  mergePR: (id: string) => Promise<void>

  getPermissions: () => Promise<RepoPermissions>
  getBranchProtection: (branch: string) => Promise<BranchProtection | null>
  detectFramework: () => Promise<FrameworkDetection>
}

// ─── Studio GitProvider factory ───

export interface StudioGitHubInput {
  installationId: number
  owner: string
  repo: string
  contentRoot?: string
  /** Public media delivery base for MCP Cloud writes (see GitProvider.mediaBaseUrl). */
  mediaBaseUrl?: string
  /**
   * Contract media facet (@contentrain/types MediaProvider). Set only for
   * media-eligible MCP Cloud loopback sessions — its presence is what makes
   * MCP's 5 media tools appear in tools/list. Absent for local/CLI
   * providers and non-eligible sessions.
   */
  media?: ContractMediaProvider
}

/**
 * Compose a Studio `GitProvider` by wrapping MCP's `GitHubProvider` with
 * Studio-specific extensions that drive off the same Octokit client.
 *
 * Installation-token lifecycle (1h TTL + auto-refresh) is handled
 * internally by `@octokit/auth-app`'s strategy, so the composed
 * instance remains usable across the full request lifetime without
 * manual token management.
 */
export function createStudioGitProvider(opts: StudioGitHubInput): GitProvider {
  const config = useRuntimeConfig()
  const privateKey = Buffer.from(config.github.privateKey, 'base64').toString('utf-8')

  const octokit = createInstallationOctokit({
    appId: config.github.appId,
    privateKey,
    installationId: opts.installationId,
  })

  const core = new GitHubProvider(octokit, {
    owner: opts.owner,
    name: opts.repo,
    contentRoot: opts.contentRoot,
  })

  const extensions = createGitHubExtensions(octokit, opts.owner, opts.repo)

  return {
    mediaBaseUrl: opts.mediaBaseUrl,
    // Contract media facet — RepoProvider.media (types 0.8.0). Undefined
    // for content-only providers, which keeps the 5 media tools hidden.
    media: opts.media,
    get capabilities() { return core.capabilities },
    readFile: (path: string, ref?: string) => core.readFile(path, ref),
    listDirectory: (path: string, ref?: string) => core.listDirectory(path, ref),
    fileExists: (path: string, ref?: string) => core.fileExists(path, ref),
    applyPlan: (input: ApplyPlanInput) => core.applyPlan(input),
    listBranches: (prefix?: string) => core.listBranches(prefix),
    createBranch: (name: string, fromRef?: string) => core.createBranch(name, fromRef),
    deleteBranch: (name: string) => core.deleteBranch(name),
    getBranchDiff: (branch: string, base?: string) => core.getBranchDiff(branch, base),
    // `removeSourceBranch: false` is load-bearing. Since MCP 1.8.0,
    // `mergeBranch` deletes the merged HEAD branch by default. Studio's
    // two-step flow merges `main → contentrain` (sync) and
    // `contentrain → main` (advance), so the default would try to delete
    // `main` (rejected by GitHub, 422) and — worse — actually delete the
    // `contentrain` SSOT branch after advancing main. Studio owns branch
    // deletion explicitly (`deleteBranch` for `cr/*` after merge, branch
    // cleanup cron), so merges must never delete their source. This
    // restores the pre-1.8.0 semantics exactly.
    mergeBranch: (branch: string, into: string) => core.mergeBranch(branch, into, { removeSourceBranch: false }),
    isMerged: (branch: string, into?: string) => core.isMerged(branch, into),
    getDefaultBranch: () => core.getDefaultBranch(),

    ...extensions,

    async commitFiles(branch, files, message, author) {
      return core.applyPlan({ branch, changes: files, message, author })
    },
  }
}
