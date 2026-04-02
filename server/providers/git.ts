export interface TreeEntry {
  path: string
  type: 'blob' | 'tree'
  sha: string
  size?: number
}

export interface Branch {
  name: string
  sha: string
  protected: boolean
}

export interface FileChange {
  path: string
  content: string | null // null = delete
}

export interface CommitAuthor {
  name: string
  email: string
}

export interface Commit {
  sha: string
  message: string
  author: CommitAuthor
  timestamp: string
}

export interface FileDiff {
  path: string
  status: 'added' | 'modified' | 'removed'
  before: string | null
  after: string | null
}

export interface MergeResult {
  merged: boolean
  sha: string | null
  pullRequestUrl: string | null
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

export interface GitProvider {
  // Tree operations (scoped to content_root + .contentrain/)
  getTree: (ref?: string) => Promise<TreeEntry[]>
  readFile: (path: string, ref?: string) => Promise<string>
  listDirectory: (path: string, ref?: string) => Promise<string[]>
  fileExists: (path: string, ref?: string) => Promise<boolean>

  // Branch operations
  createBranch: (name: string, fromRef?: string) => Promise<void>
  listBranches: (prefix?: string) => Promise<Branch[]>
  getBranchDiff: (branch: string, base?: string) => Promise<FileDiff[]>
  mergeBranch: (branch: string, into: string) => Promise<MergeResult>
  deleteBranch: (branch: string) => Promise<void>
  isMerged: (branch: string, into?: string) => Promise<boolean>

  // Commit operations
  commitFiles: (branch: string, files: FileChange[], message: string, author: CommitAuthor) => Promise<Commit>

  // PR operations (when branch protection requires it)
  createPR: (head: string, base: string, title: string, body: string) => Promise<{ id: string, url: string }>
  mergePR: (id: string) => Promise<void>

  // Permissions & config
  getPermissions: () => Promise<RepoPermissions>
  getBranchProtection: (branch: string) => Promise<BranchProtection | null>
  getDefaultBranch: () => Promise<string>

  // Detection
  detectFramework: () => Promise<FrameworkDetection>
}
