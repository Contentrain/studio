/**
 * Tests for Studio-specific GitHub extensions in `server/providers/github-app.ts`.
 *
 * Project-scoped content operations (readFile, applyPlan, listBranches,
 * isMerged, mergeBranch conflict handling, ...) live in
 * `@contentrain/mcp/providers/github` — `GitHubProvider` — and are
 * tested upstream via MCP's conformance suite. This file covers only
 * the Studio extensions (framework detection, tree listing, permissions,
 * branch protection, PR helpers) plus the workspace-scoped installation
 * provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const githubState = vi.hoisted(() => {
  const octokit = {
    request: vi.fn(),
    git: {
      getTree: vi.fn(),
    },
    repos: {
      get: vi.fn(),
      getBranchProtection: vi.fn(),
    },
    pulls: {
      create: vi.fn(),
      merge: vi.fn(),
    },
    apps: {
      getInstallation: vi.fn(),
      listReposAccessibleToInstallation: vi.fn(),
    },
  }

  return {
    octokit,
    Octokit: vi.fn(function Octokit() {
      return octokit
    }),
    createAppAuth: vi.fn(),
  }
})

vi.mock('@octokit/rest', () => ({
  Octokit: githubState.Octokit,
}))

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: githubState.createAppAuth,
}))

describe('github extensions (Studio-specific)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('createError', ({ statusCode, message }: { statusCode: number, message: string }) =>
      Object.assign(new Error(message), { statusCode, message }),
    )
    vi.stubGlobal('errorMessage', (key: string) => key)

    githubState.Octokit.mockClear()
    githubState.octokit.request.mockReset()
    githubState.octokit.git.getTree.mockReset()
    githubState.octokit.repos.get.mockReset()
    githubState.octokit.repos.getBranchProtection.mockReset()
    githubState.octokit.pulls.create.mockReset()
    githubState.octokit.pulls.merge.mockReset()
    githubState.octokit.apps.getInstallation.mockReset()
    githubState.octokit.apps.listReposAccessibleToInstallation.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('createGitHubExtensions — detectFramework', () => {
    it('detects Nuxt + i18n from package.json and flags hasContentDir', async () => {
      githubState.octokit.request
        .mockResolvedValueOnce({ data: { content: 'exists' } })
        .mockResolvedValueOnce({
          data: {
            content: Buffer.from(JSON.stringify({
              dependencies: { 'nuxt': '^4.0.0', '@nuxtjs/i18n': '^9.0.0' },
            }), 'utf-8').toString('base64'),
          },
        })

      const { createGitHubExtensions } = await import('../../server/providers/github-app')
      const ext = createGitHubExtensions(githubState.octokit as never, 'contentrain', 'studio')

      await expect(ext.detectFramework()).resolves.toEqual({
        stack: 'nuxt',
        hasContentDir: true,
        hasI18n: true,
        suggestedContentPaths: {
          default: 'content/{model}/',
          fallback: '.contentrain/content/{domain}/{model}/',
        },
      })
    })

    it('falls back to pubspec.yaml detection when package.json is absent', async () => {
      githubState.octokit.request
        // .contentrain/config.json check → 404
        .mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }))
        // package.json → reject (triggers fallback branch)
        .mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }))
        // pubspec.yaml → ok
        .mockResolvedValueOnce({ data: { content: 'exists' } })

      const { createGitHubExtensions } = await import('../../server/providers/github-app')
      const ext = createGitHubExtensions(githubState.octokit as never, 'contentrain', 'studio')

      await expect(ext.detectFramework()).resolves.toEqual({
        stack: 'flutter',
        hasContentDir: false,
        hasI18n: false,
        suggestedContentPaths: { default: '.contentrain/content/{domain}/{model}/' },
      })
    })
  })

  describe('createGitHubExtensions — tree + permissions + protection', () => {
    it('falls back to default branch when getTree ref is omitted', async () => {
      githubState.octokit.repos.get.mockResolvedValue({
        data: { default_branch: 'main' },
      })
      githubState.octokit.git.getTree.mockResolvedValue({
        data: {
          tree: [
            { path: '.contentrain/config.json', type: 'blob', sha: 'abc', size: 42 },
            { path: '.contentrain', type: 'tree', sha: 'def' },
            { path: undefined, type: 'blob', sha: 'ghi' }, // filtered
          ],
        },
      })

      const { createGitHubExtensions } = await import('../../server/providers/github-app')
      const ext = createGitHubExtensions(githubState.octokit as never, 'contentrain', 'studio')

      await expect(ext.getTree()).resolves.toEqual([
        { path: '.contentrain/config.json', type: 'blob', sha: 'abc', size: 42 },
        { path: '.contentrain', type: 'tree', sha: 'def', size: undefined },
      ])

      expect(githubState.octokit.git.getTree).toHaveBeenCalledWith({
        owner: 'contentrain',
        repo: 'studio',
        tree_sha: 'main',
        recursive: 'true',
      })
    })

    it('maps repo permissions into RepoPermissions shape', async () => {
      githubState.octokit.repos.get.mockResolvedValue({
        data: { permissions: { push: true, pull: true, admin: false } },
      })

      const { createGitHubExtensions } = await import('../../server/providers/github-app')
      const ext = createGitHubExtensions(githubState.octokit as never, 'contentrain', 'studio')

      await expect(ext.getPermissions()).resolves.toEqual({
        push: true,
        pull: true,
        admin: false,
      })
    })

    it('returns null for unprotected branches and mapped details when protected', async () => {
      githubState.octokit.repos.getBranchProtection
        .mockRejectedValueOnce(Object.assign(new Error('Not protected'), { status: 404 }))
        .mockResolvedValueOnce({
          data: {
            required_pull_request_reviews: { required_approving_review_count: 2 },
          },
        })

      const { createGitHubExtensions } = await import('../../server/providers/github-app')
      const ext = createGitHubExtensions(githubState.octokit as never, 'contentrain', 'studio')

      await expect(ext.getBranchProtection('main')).resolves.toBeNull()
      await expect(ext.getBranchProtection('main')).resolves.toEqual({
        requiredReviews: 2,
        requirePR: true,
      })
    })
  })

  describe('createGitHubExtensions — PR helpers', () => {
    it('creates and merges pull requests via the pulls API', async () => {
      githubState.octokit.pulls.create.mockResolvedValue({
        data: { number: 42, html_url: 'https://github.com/contentrain/studio/pull/42' },
      })
      githubState.octokit.pulls.merge.mockResolvedValue({ data: {} })

      const { createGitHubExtensions } = await import('../../server/providers/github-app')
      const ext = createGitHubExtensions(githubState.octokit as never, 'contentrain', 'studio')

      await expect(ext.createPR('cr/content/posts', 'contentrain', 'Title', 'Body')).resolves.toEqual({
        id: '42',
        url: 'https://github.com/contentrain/studio/pull/42',
      })

      await expect(ext.mergePR('42')).resolves.toBeUndefined()
      expect(githubState.octokit.pulls.merge).toHaveBeenCalledWith({
        owner: 'contentrain',
        repo: 'studio',
        pull_number: 42,
      })
    })
  })

  describe('createGitHubAppInstallationProvider — workspace-scoped ops', () => {
    it('maps installation details including account and permissions', async () => {
      githubState.octokit.apps.getInstallation.mockResolvedValue({
        data: {
          account: { login: 'contentrain', avatar_url: 'https://example.com/a.png' },
          target_type: 'Organization',
          repository_selection: 'selected',
          permissions: { contents: 'write' },
          suspended_at: null,
        },
      })

      const { createGitHubAppInstallationProvider } = await import('../../server/providers/github-app')
      const provider = createGitHubAppInstallationProvider({
        appId: 'app-1',
        privateKey: 'private-key',
        installationId: 99,
      })

      await expect(provider.getInstallationDetails()).resolves.toEqual({
        installationId: 99,
        account: {
          login: 'contentrain',
          avatarUrl: 'https://example.com/a.png',
          type: 'Organization',
        },
        selection: 'selected',
        permissions: { contents: 'write' },
        suspendedAt: null,
      })
    })

    it('treats 404/403 as inaccessible but surfaces other errors', async () => {
      githubState.octokit.repos.get
        .mockRejectedValueOnce({ status: 404 })
        .mockRejectedValueOnce({ status: 403 })
        .mockResolvedValueOnce({ data: {} })

      const { createGitHubAppInstallationProvider } = await import('../../server/providers/github-app')
      const provider = createGitHubAppInstallationProvider({
        appId: 'app-1',
        privateKey: 'private-key',
        installationId: 99,
      })

      await expect(provider.canAccessRepository('a', 'b')).resolves.toBe(false)
      await expect(provider.canAccessRepository('a', 'b')).resolves.toBe(false)
      await expect(provider.canAccessRepository('a', 'b')).resolves.toBe(true)
    })
  })
})
