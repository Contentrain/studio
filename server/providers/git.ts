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
}

// ─── GitProvider: RepoProvider + Studio extensions ───

export interface GitProvider extends RepoProvider {
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
    get capabilities() { return core.capabilities },
    readFile: (path: string, ref?: string) => core.readFile(path, ref),
    listDirectory: (path: string, ref?: string) => core.listDirectory(path, ref),
    fileExists: (path: string, ref?: string) => core.fileExists(path, ref),
    applyPlan: (input: ApplyPlanInput) => core.applyPlan(input),
    listBranches: (prefix?: string) => core.listBranches(prefix),
    createBranch: (name: string, fromRef?: string) => core.createBranch(name, fromRef),
    deleteBranch: (name: string) => core.deleteBranch(name),
    getBranchDiff: (branch: string, base?: string) => core.getBranchDiff(branch, base),
    mergeBranch: (branch: string, into: string) => core.mergeBranch(branch, into),
    isMerged: (branch: string, into?: string) => core.isMerged(branch, into),
    getDefaultBranch: () => core.getDefaultBranch(),

    ...extensions,

    async commitFiles(branch, files, message, author) {
      return core.applyPlan({ branch, changes: files, message, author })
    },
  }
}
