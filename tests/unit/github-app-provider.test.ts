import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const githubState = vi.hoisted(() => {
  const octokit = {
    request: vi.fn(),
    git: {
      getRef: vi.fn(),
      getCommit: vi.fn(),
      createBlob: vi.fn(),
      createTree: vi.fn(),
      createCommit: vi.fn(),
      updateRef: vi.fn(),
      getTree: vi.fn(),
      deleteRef: vi.fn(),
    },
    repos: {
      get: vi.fn(),
      listBranches: vi.fn(),
      compareCommits: vi.fn(),
      merge: vi.fn(),
      getBranchProtection: vi.fn(),
    },
    pulls: {
      create: vi.fn(),
      merge: vi.fn(),
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

describe('github app provider', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('createError', ({ statusCode, message }: { statusCode: number, message: string }) =>
      Object.assign(new Error(message), { statusCode, message }),
    )

    githubState.Octokit.mockClear()
    githubState.octokit.request.mockReset()
    githubState.octokit.git.getRef.mockReset()
    githubState.octokit.git.getCommit.mockReset()
    githubState.octokit.git.createBlob.mockReset()
    githubState.octokit.git.createTree.mockReset()
    githubState.octokit.git.createCommit.mockReset()
    githubState.octokit.git.updateRef.mockReset()
    githubState.octokit.git.getTree.mockReset()
    githubState.octokit.repos.get.mockReset()
    githubState.octokit.repos.listBranches.mockReset()
    githubState.octokit.repos.compareCommits.mockReset()
    githubState.octokit.repos.merge.mockReset()
    githubState.octokit.repos.getBranchProtection.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reads files and directories through the GitHub contents API', async () => {
    githubState.octokit.request
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from('hello world', 'utf-8').toString('base64'),
          encoding: 'base64',
        },
      })
      .mockResolvedValueOnce({
        data: [{ name: 'posts' }, { name: 'pages' }],
      })
      .mockResolvedValueOnce({ data: { content: 'exists' } })
      .mockRejectedValueOnce(new Error('Not found'))

    const { createGitHubAppProvider } = await import('../../server/providers/github-app')
    const provider = createGitHubAppProvider({
      appId: 'app-1',
      privateKey: 'private-key',
      installationId: 1,
      owner: 'contentrain',
      repo: 'studio',
    })

    await expect(provider.readFile('package.json')).resolves.toBe('hello world')
    await expect(provider.listDirectory('content')).resolves.toEqual(['posts', 'pages'])
    await expect(provider.fileExists('README.md')).resolves.toBe(true)
    await expect(provider.fileExists('missing.md')).resolves.toBe(false)
  })

  it('detects framework and content capabilities from repository files', async () => {
    githubState.octokit.request
      .mockResolvedValueOnce({ data: { content: 'exists' } })
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from(JSON.stringify({
            dependencies: { 'nuxt': '^4.0.0', '@nuxtjs/i18n': '^9.0.0' },
          }), 'utf-8').toString('base64'),
        },
      })

    const { createGitHubAppProvider } = await import('../../server/providers/github-app')
    const provider = createGitHubAppProvider({
      appId: 'app-1',
      privateKey: 'private-key',
      installationId: 1,
      owner: 'contentrain',
      repo: 'studio',
    })

    await expect(provider.detectFramework()).resolves.toEqual({
      stack: 'nuxt',
      hasContentDir: true,
      hasI18n: true,
      suggestedContentPaths: {
        default: 'content/{model}/',
        fallback: '.contentrain/content/{domain}/{model}/',
      },
    })
  })

  it('creates atomic multi-file commits through the Git data API', async () => {
    githubState.octokit.git.getRef.mockResolvedValue({
      data: { object: { sha: 'head-sha' } },
    })
    githubState.octokit.git.getCommit.mockResolvedValue({
      data: { tree: { sha: 'tree-sha' } },
    })
    githubState.octokit.git.createBlob
      .mockResolvedValueOnce({ data: { sha: 'blob-1' } })
      .mockResolvedValueOnce({ data: { sha: 'blob-2' } })
    githubState.octokit.git.createTree.mockResolvedValue({
      data: { sha: 'new-tree-sha' },
    })
    githubState.octokit.git.createCommit.mockResolvedValue({
      data: {
        sha: 'commit-sha',
        message: 'Save content',
        author: {
          name: 'Studio Bot',
          email: 'bot@example.com',
          date: '2026-03-26T00:00:00.000Z',
        },
      },
    })
    githubState.octokit.git.updateRef.mockResolvedValue({ data: {} })

    const { createGitHubAppProvider } = await import('../../server/providers/github-app')
    const provider = createGitHubAppProvider({
      appId: 'app-1',
      privateKey: 'private-key',
      installationId: 1,
      owner: 'contentrain',
      repo: 'studio',
    })

    await expect(provider.commitFiles('contentrain/save-1', [
      { path: 'content/posts/en.json', content: '{"entry":1}' },
      { path: 'content/pages/en.json', content: '{"entry":2}' },
      { path: 'content/old.json', content: null },
    ], 'Save content', { name: 'Studio Bot', email: 'bot@example.com' })).resolves.toEqual({
      sha: 'commit-sha',
      message: 'Save content',
      author: {
        name: 'Studio Bot',
        email: 'bot@example.com',
      },
      timestamp: '2026-03-26T00:00:00.000Z',
    })

    expect(githubState.octokit.git.createTree).toHaveBeenCalled()
    expect(githubState.octokit.git.updateRef).toHaveBeenCalledWith({
      owner: 'contentrain',
      repo: 'studio',
      ref: 'heads/contentrain/save-1',
      sha: 'commit-sha',
    })
  })

  it('maps merge conflicts to non-merged results and returns null when branch protection is unavailable', async () => {
    githubState.octokit.repos.merge.mockRejectedValue({ status: 409 })
    githubState.octokit.repos.getBranchProtection.mockRejectedValue(new Error('Not protected'))

    const { createGitHubAppProvider } = await import('../../server/providers/github-app')
    const provider = createGitHubAppProvider({
      appId: 'app-1',
      privateKey: 'private-key',
      installationId: 1,
      owner: 'contentrain',
      repo: 'studio',
    })

    await expect(provider.mergeBranch('contentrain/save-1', 'main')).resolves.toEqual({
      merged: false,
      sha: null,
      pullRequestUrl: null,
    })
    await expect(provider.getBranchProtection('main')).resolves.toBeNull()
  })
})
