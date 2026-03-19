import { Octokit } from '@octokit/rest'
import { createAppAuth } from '@octokit/auth-app'
import type {
  Branch,
  BranchProtection,
  Commit,
  CommitAuthor,
  FileChange,
  FileDiff,
  FrameworkDetection,
  GitProvider,
  MergeResult,
  RepoPermissions,
  TreeEntry,
} from './git'

interface GitHubAppConfig {
  appId: string
  privateKey: string
  installationId: number
  owner: string
  repo: string
}

/**
 * GitHub App implementation of GitProvider.
 *
 * Uses installation tokens (short-lived, auto-refreshed by Octokit)
 * to access repository content via GitHub API.
 *
 * Phase 1: Read operations active.
 * Phase 2: Write operations (commit, branch, PR) active.
 */
export function createGitHubAppProvider(config: GitHubAppConfig): GitProvider {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
    },
  })

  const { owner, repo } = config

  return {
    async getTree(ref?: string): Promise<TreeEntry[]> {
      const branch = ref || await this.getDefaultBranch()

      const { data } = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: branch,
        recursive: 'true',
      })

      return data.tree
        .filter(item => item.path && item.type)
        .map(item => ({
          path: item.path!,
          type: item.type as 'blob' | 'tree',
          sha: item.sha!,
          size: item.size ?? undefined,
        }))
    },

    async readFile(path: string, ref?: string): Promise<string> {
      const params: { owner: string, repo: string, path: string, ref?: string } = { owner, repo, path }
      if (ref) params.ref = ref

      const { data } = await octokit.repos.getContent(params) as { data: { content?: string, encoding?: string } }

      if (!data.content)
        throw createError({ statusCode: 404, message: `File not found: ${path}` })

      return Buffer.from(data.content, 'base64').toString('utf-8')
    },

    async listDirectory(path: string, ref?: string): Promise<string[]> {
      const params: { owner: string, repo: string, path: string, ref?: string } = { owner, repo, path }
      if (ref) params.ref = ref

      const { data } = await octokit.repos.getContent(params)

      if (!Array.isArray(data))
        throw createError({ statusCode: 400, message: `Not a directory: ${path}` })

      return data.map((item: { name: string }) => item.name)
    },

    async fileExists(path: string, ref?: string): Promise<boolean> {
      try {
        const params: { owner: string, repo: string, path: string, ref?: string } = { owner, repo, path }
        if (ref) params.ref = ref
        await octokit.repos.getContent(params)
        return true
      }
      catch {
        return false
      }
    },

    async getDefaultBranch(): Promise<string> {
      const { data } = await octokit.repos.get({ owner, repo })
      return data.default_branch
    },

    async listBranches(prefix?: string): Promise<Branch[]> {
      const { data } = await octokit.repos.listBranches({
        owner,
        repo,
        per_page: 100,
      })

      const branches = data.map(b => ({
        name: b.name,
        sha: b.commit.sha,
        protected: b.protected,
      }))

      if (prefix)
        return branches.filter(b => b.name.startsWith(prefix))

      return branches
    },

    async detectFramework(): Promise<FrameworkDetection> {
      const result: FrameworkDetection = {
        stack: 'unknown',
        hasContentDir: false,
        hasI18n: false,
        suggestedContentPaths: {},
      }

      // Check for .contentrain/ directory
      result.hasContentDir = await this.fileExists('.contentrain/config.json')

      // Try reading package.json for framework detection
      try {
        const pkgJson = JSON.parse(await this.readFile('package.json'))
        const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies }

        if (deps.nuxt) result.stack = 'nuxt'
        else if (deps.next) result.stack = 'next'
        else if (deps.astro) result.stack = 'astro'
        else if (deps['@sveltejs/kit']) result.stack = 'sveltekit'
        else if (deps.vue) result.stack = 'vue'
        else if (deps.react) result.stack = 'react'

        result.hasI18n = !!(deps['vue-i18n'] || deps['next-i18next'] || deps['@nuxtjs/i18n'] || deps['astro-i18n'])
      }
      catch {
        // No package.json — check for other project types
        if (await this.fileExists('pubspec.yaml')) result.stack = 'flutter'
        else if (await this.fileExists('build.gradle')) result.stack = 'android'
        else if (await this.fileExists('Package.swift')) result.stack = 'ios'
        else if (await this.fileExists('go.mod')) result.stack = 'go'
      }

      // Suggest content paths based on stack
      const pathMap: Record<string, Record<string, string>> = {
        nuxt: { default: 'content/{model}/', fallback: '.contentrain/content/{domain}/{model}/' },
        astro: { default: 'src/content/{model}/', fallback: '.contentrain/content/{domain}/{model}/' },
      }
      result.suggestedContentPaths = pathMap[result.stack] ?? { default: '.contentrain/content/{domain}/{model}/' }

      return result
    },

    // --- Write operations (stubs — Phase 2) ---

    async createBranch(_name: string, _fromRef?: string): Promise<void> {
      throw createError({ statusCode: 501, message: 'Branch creation available in Phase 2' })
    },

    async getBranchDiff(_branch: string, _base?: string): Promise<FileDiff[]> {
      throw createError({ statusCode: 501, message: 'Branch diff available in Phase 2' })
    },

    async mergeBranch(_branch: string, _into: string): Promise<MergeResult> {
      throw createError({ statusCode: 501, message: 'Branch merge available in Phase 2' })
    },

    async deleteBranch(_branch: string): Promise<void> {
      throw createError({ statusCode: 501, message: 'Branch delete available in Phase 2' })
    },

    async commitFiles(_branch: string, _files: FileChange[], _message: string, _author: CommitAuthor): Promise<Commit> {
      throw createError({ statusCode: 501, message: 'Commits available in Phase 2' })
    },

    async createPR(_head: string, _base: string, _title: string, _body: string): Promise<{ id: string, url: string }> {
      throw createError({ statusCode: 501, message: 'PR creation available in Phase 2' })
    },

    async mergePR(_id: string): Promise<void> {
      throw createError({ statusCode: 501, message: 'PR merge available in Phase 2' })
    },

    async getPermissions(): Promise<RepoPermissions> {
      const { data } = await octokit.repos.get({ owner, repo })
      return {
        push: data.permissions?.push ?? false,
        pull: data.permissions?.pull ?? false,
        admin: data.permissions?.admin ?? false,
      }
    },

    async getBranchProtection(branch: string): Promise<BranchProtection | null> {
      try {
        const { data } = await octokit.repos.getBranchProtection({ owner, repo, branch })
        return {
          requiredReviews: data.required_pull_request_reviews?.required_approving_review_count ?? 0,
          requirePR: !!data.required_pull_request_reviews,
        }
      }
      catch {
        return null
      }
    },
  }
}
