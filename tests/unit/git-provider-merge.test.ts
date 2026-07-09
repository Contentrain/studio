/**
 * Regression guard for the MCP 1.8.0 auto-delete-source behavior.
 *
 * Since MCP 1.8.0, `GitHubProvider.mergeBranch` deletes the merged HEAD
 * branch by default (`removeSourceBranch` defaults to true). Studio's
 * two-step flow merges `main → contentrain` and `contentrain → main`, so
 * the default would delete `main` (422) and the `contentrain` SSOT
 * branch. Studio owns branch deletion explicitly, so its `mergeBranch`
 * wrapper MUST pass `removeSourceBranch: false`. This test fails if that
 * opt is ever dropped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const coreMergeBranch = vi.hoisted(() => vi.fn().mockResolvedValue({ merged: true, sha: 'x', pullRequestUrl: null }))

vi.mock('@contentrain/mcp/providers/github', () => ({
  GitHubProvider: vi.fn(function GitHubProvider() {
    return { mergeBranch: coreMergeBranch }
  }),
}))

vi.mock('../../server/providers/github-app', () => ({
  createInstallationOctokit: vi.fn(() => ({})),
  createGitHubExtensions: vi.fn(() => ({})),
}))

describe('Studio git provider — mergeBranch never auto-deletes the source', () => {
  beforeEach(() => {
    vi.resetModules()
    coreMergeBranch.mockClear()
    vi.stubGlobal('useRuntimeConfig', () => ({
      github: { appId: '1', privateKey: Buffer.from('key').toString('base64') },
    }))
  })

  it('passes removeSourceBranch: false to MCP mergeBranch', async () => {
    const { createStudioGitProvider } = await import('../../server/providers/git')
    const git = createStudioGitProvider({ installationId: 1, owner: 'acme', repo: 'site' })

    await git.mergeBranch('contentrain', 'main')

    expect(coreMergeBranch).toHaveBeenCalledWith('contentrain', 'main', { removeSourceBranch: false })
  })
})
