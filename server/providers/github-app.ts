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
  GitAppProvider,
  GitProvider,
  InstallationDetails,
  InstallationRepository,
  MergeResult,
  RepoPermissions,
  TemplateRepositoryInput,
  TreeEntry,
} from './git'

interface GitHubAppBaseConfig {
  appId: string
  privateKey: string
  installationId: number
}

interface GitHubAppConfig extends GitHubAppBaseConfig {
  owner: string
  repo: string
}

function createInstallationOctokit(config: GitHubAppBaseConfig) {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
    },
  })
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
  const octokit = createInstallationOctokit(config)

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
      // Use manual URL to avoid @octokit/endpoint encoding slashes in path as %2F
      const { data } = await octokit.request({
        method: 'GET',
        url: `/repos/${owner}/${repo}/contents/${path}`,
        ...(ref ? { ref } : {}),
      }) as { data: { content?: string, encoding?: string } }

      if (!data.content)
        throw createError({ statusCode: 404, message: errorMessage('github.file_not_found', { path }) })

      return Buffer.from(data.content, 'base64').toString('utf-8')
    },

    async listDirectory(path: string, ref?: string): Promise<string[]> {
      // Use manual URL to avoid @octokit/endpoint encoding slashes in path as %2F
      const { data } = await octokit.request({
        method: 'GET',
        url: `/repos/${owner}/${repo}/contents/${path}`,
        ...(ref ? { ref } : {}),
      })

      if (!Array.isArray(data))
        throw createError({ statusCode: 400, message: errorMessage('github.not_a_directory', { path }) })

      return data.map((item: { name: string }) => item.name)
    },

    async fileExists(path: string, ref?: string): Promise<boolean> {
      try {
        // Use manual URL to avoid @octokit/endpoint encoding slashes in path as %2F
        await octokit.request({
          method: 'GET',
          url: `/repos/${owner}/${repo}/contents/${path}`,
          ...(ref ? { ref } : {}),
        })
        return true
      }
      catch (err: unknown) {
        const status = (err as { status?: number }).status
        if (status === 404) return false
        throw err
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

    // --- Write operations ---

    async createBranch(name: string, fromRef?: string): Promise<void> {
      // Get SHA to branch from
      let sha: string
      if (fromRef) {
        const { data } = await octokit.git.getRef({ owner, repo, ref: `heads/${fromRef}` })
        sha = data.object.sha
      }
      else {
        const defaultBranch = await this.getDefaultBranch()
        const { data } = await octokit.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` })
        sha = data.object.sha
      }

      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${name}`,
        sha,
      })
    },

    async getBranchDiff(branch: string, base?: string): Promise<FileDiff[]> {
      const baseBranch = base ?? await this.getDefaultBranch()

      const { data } = await octokit.repos.compareCommits({
        owner,
        repo,
        base: baseBranch,
        head: branch,
      })

      return (data.files ?? []).map((file) => {
        const statusMap: Record<string, FileDiff['status']> = {
          added: 'added',
          removed: 'removed',
          modified: 'modified',
          renamed: 'modified',
          changed: 'modified',
        }
        return {
          path: file.filename,
          status: statusMap[file.status] ?? 'modified',
          before: file.status === 'added' ? null : (file.patch ?? null),
          after: file.status === 'removed' ? null : (file.patch ?? null),
        }
      })
    },

    async mergeBranch(branch: string, into: string): Promise<MergeResult> {
      try {
        const { data } = await octokit.repos.merge({
          owner,
          repo,
          base: into,
          head: branch,
          commit_message: `Merge ${branch} into ${into}`,
        })
        return {
          merged: true,
          sha: data.sha,
          pullRequestUrl: null,
        }
      }
      catch (e: unknown) {
        // Merge conflict
        if (e && typeof e === 'object' && 'status' in e && e.status === 409) {
          return { merged: false, sha: null, pullRequestUrl: null }
        }
        throw e
      }
    },

    async deleteBranch(branch: string): Promise<void> {
      await octokit.git.deleteRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      })
    },

    async commitFiles(branch: string, files: FileChange[], message: string, author: CommitAuthor): Promise<Commit> {
      // Multi-file atomic commit via Git Data API:
      // 1. Get branch HEAD
      // 2. Get base tree
      // 3. Create blobs for each file
      // 4. Create new tree
      // 5. Create commit
      // 6. Update branch ref

      // 1. Get HEAD sha
      const { data: refData } = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      })
      const headSha = refData.object.sha

      // 2. Get base tree
      const { data: commitData } = await octokit.git.getCommit({
        owner,
        repo,
        commit_sha: headSha,
      })
      const baseTreeSha = commitData.tree.sha

      // 3. Create blobs + build tree entries
      const treeEntries: Array<{
        path: string
        mode: '100644'
        type: 'blob'
        sha?: string | null
      }> = []

      for (const file of files) {
        if (file.content === null) {
          // Delete: set sha to null (remove from tree)
          treeEntries.push({
            path: file.path,
            mode: '100644',
            type: 'blob',
            sha: null,
          })
        }
        else {
          // Create/update: create blob first
          const { data: blob } = await octokit.git.createBlob({
            owner,
            repo,
            content: file.content,
            encoding: 'utf-8',
          })
          treeEntries.push({
            path: file.path,
            mode: '100644',
            type: 'blob',
            sha: blob.sha,
          })
        }
      }

      // 4. Create new tree
      const { data: newTree } = await octokit.git.createTree({
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: treeEntries as { path?: string, mode?: '100644' | '100755' | '040000' | '160000' | '120000', type?: 'blob' | 'tree' | 'commit', sha?: string | null, content?: string }[],
      })

      // 5. Create commit
      const { data: newCommit } = await octokit.git.createCommit({
        owner,
        repo,
        message,
        tree: newTree.sha,
        parents: [headSha],
        author: {
          name: author.name,
          email: author.email,
          date: new Date().toISOString(),
        },
      })

      // 6. Update branch ref
      await octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: newCommit.sha,
      })

      return {
        sha: newCommit.sha,
        message: newCommit.message,
        author: {
          name: newCommit.author?.name ?? author.name,
          email: newCommit.author?.email ?? author.email,
        },
        timestamp: newCommit.author?.date ?? new Date().toISOString(),
      }
    },

    async createPR(head: string, base: string, title: string, body: string): Promise<{ id: string, url: string }> {
      const { data } = await octokit.pulls.create({
        owner,
        repo,
        head,
        base,
        title,
        body,
      })
      return {
        id: String(data.number),
        url: data.html_url,
      }
    },

    async mergePR(id: string): Promise<void> {
      await octokit.pulls.merge({
        owner,
        repo,
        pull_number: Number(id),
      })
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
      catch (err: unknown) {
        const status = (err as { status?: number }).status
        if (status === 404) return null
        throw err
      }
    },
  }
}

export function createGitHubAppInstallationProvider(config: GitHubAppBaseConfig): GitAppProvider {
  const octokit = createInstallationOctokit(config)

  return {
    async getInstallationDetails(): Promise<InstallationDetails> {
      const { data } = await octokit.apps.getInstallation({
        installation_id: config.installationId,
      })

      return {
        installationId: config.installationId,
        account: {
          login: (data.account as { login?: string })?.login ?? null,
          avatarUrl: (data.account as { avatar_url?: string })?.avatar_url ?? null,
          type: data.target_type ?? null,
        },
        selection: data.repository_selection ?? null,
        permissions: (data.permissions as Record<string, string> | undefined) ?? null,
        suspendedAt: data.suspended_at ?? null,
      }
    },

    async listInstallationRepositories(): Promise<InstallationRepository[]> {
      const { data } = await octokit.apps.listReposAccessibleToInstallation({
        per_page: 100,
      })

      return data.repositories.map(repo => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner.login,
        private: repo.private,
        defaultBranch: repo.default_branch,
        description: repo.description,
        language: repo.language,
        updatedAt: repo.updated_at,
        htmlUrl: repo.html_url,
      }))
    },

    async createRepositoryFromTemplate(input: TemplateRepositoryInput): Promise<InstallationRepository> {
      const details = await this.getInstallationDetails()
      const targetOwner = details.account.login

      if (!targetOwner) {
        throw createError({ statusCode: 500, message: errorMessage('github.owner_not_resolved') })
      }

      const { data } = await octokit.repos.createUsingTemplate({
        template_owner: input.templateOwner,
        template_repo: input.templateRepo,
        owner: targetOwner,
        name: input.name,
        private: input.private ?? false,
        description: input.description || undefined,
        include_all_branches: false,
      })

      return {
        id: data.id,
        name: data.name,
        fullName: data.full_name,
        owner: data.owner.login,
        private: data.private,
        defaultBranch: data.default_branch,
        description: data.description,
        htmlUrl: data.html_url,
      }
    },

    async canAccessRepository(owner: string, repo: string): Promise<boolean> {
      try {
        await octokit.repos.get({ owner, repo })
        return true
      }
      catch (err: unknown) {
        const status = (err as { status?: number }).status
        if (status === 404 || status === 403) return false
        throw err
      }
    },
  }
}
