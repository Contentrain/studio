/**
 * GitHub App integration primitives for Studio.
 *
 * This module intentionally stays thin. Project-scoped content operations
 * (readFile, applyPlan, listBranches, ...) are provided by MCP's
 * `GitHubProvider` from `@contentrain/mcp/providers/github`, composed by
 * `createStudioGitProvider()` in `./git.ts`.
 *
 * What lives here:
 *
 * 1. `createInstallationOctokit` — the installation-authenticated Octokit
 *    factory. `@octokit/auth-app`'s strategy handles the 1-hour
 *    installation-token TTL + refresh transparently, so the same client
 *    instance remains usable for the full request lifetime.
 *
 * 2. `createGitHubExtensions` — Studio-specific helpers that live outside
 *    MCP's commodity surface: tree listing for brain-cache, PR helpers for
 *    merge fallbacks, permission / protection introspection, framework
 *    detection for project setup.
 *
 * 3. `createGitHubAppInstallationProvider` — workspace-scoped GitHub App
 *    operations (list repos, create from template, check access). Not
 *    project-scoped, so it stays out of `RepoProvider`'s contract.
 */

import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'
import type {
  BranchProtection,
  FrameworkDetection,
  GitAppProvider,
  InstallationDetails,
  InstallationRepository,
  RepoPermissions,
  TemplateRepositoryInput,
  TreeEntry,
} from './git'

interface GitHubAppBaseConfig {
  appId: string
  privateKey: string
  installationId: number
}

/**
 * Build an installation-token-authenticated Octokit client.
 *
 * Token refresh is handled internally by `@octokit/auth-app`; callers
 * must not attempt manual re-auth or token extraction.
 */
export function createInstallationOctokit(config: GitHubAppBaseConfig): Octokit {
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
 * Studio-specific operations that extend MCP's `GitHubProvider` without
 * reimplementing its content-ops surface. Bundled together so a single
 * factory emits all of them against the same Octokit instance.
 */
export function createGitHubExtensions(octokit: Octokit, owner: string, repo: string) {
  async function fileExistsAtPath(path: string): Promise<boolean> {
    try {
      await octokit.request({ method: 'GET', url: `/repos/${owner}/${repo}/contents/${path}` })
      return true
    }
    catch (err: unknown) {
      const status = (err as { status?: number }).status
      if (status === 404) return false
      throw err
    }
  }

  return {
    async getTree(ref?: string): Promise<TreeEntry[]> {
      let sha = ref
      if (!sha) {
        const { data } = await octokit.repos.get({ owner, repo })
        sha = data.default_branch
      }

      const { data } = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: sha,
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

    async createPR(head: string, base: string, title: string, body: string): Promise<{ id: string, url: string }> {
      const { data } = await octokit.pulls.create({ owner, repo, head, base, title, body })
      return { id: String(data.number), url: data.html_url }
    },

    async mergePR(id: string): Promise<void> {
      await octokit.pulls.merge({ owner, repo, pull_number: Number(id) })
    },

    async detectFramework(): Promise<FrameworkDetection> {
      const result: FrameworkDetection = {
        stack: 'unknown',
        hasContentDir: false,
        hasI18n: false,
        suggestedContentPaths: {},
      }

      result.hasContentDir = await fileExistsAtPath('.contentrain/config.json')

      try {
        const { data } = await octokit.request({
          method: 'GET',
          url: `/repos/${owner}/${repo}/contents/package.json`,
        }) as { data: { content?: string, encoding?: string } }

        if (data.content) {
          const pkgJson = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'))
          const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies }

          if (deps.nuxt) result.stack = 'nuxt'
          else if (deps.next) result.stack = 'next'
          else if (deps.astro) result.stack = 'astro'
          else if (deps['@sveltejs/kit']) result.stack = 'sveltekit'
          else if (deps.vue) result.stack = 'vue'
          else if (deps.react) result.stack = 'react'

          result.hasI18n = !!(
            deps['vue-i18n']
            || deps['next-i18next']
            || deps['@nuxtjs/i18n']
            || deps['astro-i18n']
          )
        }
      }
      catch {
        if (await fileExistsAtPath('pubspec.yaml')) result.stack = 'flutter'
        else if (await fileExistsAtPath('build.gradle')) result.stack = 'android'
        else if (await fileExistsAtPath('Package.swift')) result.stack = 'ios'
        else if (await fileExistsAtPath('go.mod')) result.stack = 'go'
      }

      const pathMap: Record<string, Record<string, string>> = {
        nuxt: { default: 'content/{model}/', fallback: '.contentrain/content/{domain}/{model}/' },
        astro: { default: 'src/content/{model}/', fallback: '.contentrain/content/{domain}/{model}/' },
      }
      result.suggestedContentPaths = pathMap[result.stack] ?? { default: '.contentrain/content/{domain}/{model}/' }

      return result
    },
  }
}

/**
 * Workspace-scoped GitHub App operations. Exists outside `RepoProvider`
 * because these calls are not project-scoped — they enumerate or create
 * repositories, not operate on a single one.
 */
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
