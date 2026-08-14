import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadVocabularyPatchHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/vocabulary.patch')).default
}

const VOCAB_JSON = JSON.stringify({ version: 1, terms: { cta: { en: 'Get started' } } })

function stubCommonGlobals(overrides: { mergeBranch: ReturnType<typeof vi.fn> }, git: Record<string, unknown>) {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'workspaceId') return 'workspace-1'
    if (key === 'projectId') return 'project-1'
    return undefined
  }))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
    user: { id: 'editor-1', email: 'editor@example.com' },
    accessToken: 'token-1',
  }))
  vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
    workspaceRole: 'owner',
    availableTools: ['save_content'],
    specificModels: false,
    allowedModels: [],
  }))
  vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({ git, contentRoot: '' }))
  vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({
    ensureContentBranch: vi.fn().mockResolvedValue(undefined),
    mergeBranch: overrides.mergeBranch,
  }))
  vi.stubGlobal('generateBranchName', vi.fn(() => 'cr/content/vocabulary/1234567890-abcd'))
  vi.stubGlobal('invalidateBrainCache', vi.fn())
}

describe('vocabulary route — merge-conflict resilience', () => {
  it('retries when the GitHub merge throws a 409 conflict instead of surfacing a 500', async () => {
    // The provider re-throws GitHub's 409 on a real merge conflict; the
    // route used to let it escape the retry loop (unhandled 500 on
    // staging, 2026-08-13 14:04Z).
    const mergeBranch = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Merge conflict'), { status: 409 }))
      .mockResolvedValueOnce({ merged: true, sha: 'sha-2', pullRequestUrl: null })
    const git = {
      readFile: vi.fn().mockResolvedValue(VOCAB_JSON),
      applyPlan: vi.fn().mockResolvedValue({ sha: 'commit-1' }),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    }
    stubCommonGlobals({ mergeBranch }, git)

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/vocabulary', handler: await loadVocabularyPatchHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/vocabulary', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ terms: { cta: { en: 'Get started' } } }),
      })

      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload.merged).toBe(true)
      expect(payload.vocabulary.terms.cta.en).toBe('Get started')
      // conflicted attempt cleaned its branch up, then a fresh write retried
      expect(git.deleteBranch).toHaveBeenCalledTimes(1)
      expect(git.applyPlan).toHaveBeenCalledTimes(2)
      expect(mergeBranch).toHaveBeenCalledTimes(2)
    })
  })

  it('treats a PR fallback (protected main) as landed, not as a conflict to retry', async () => {
    // finalize returns merged:false + pullRequestUrl when main is
    // protected — but the vocabulary already reached `contentrain`.
    // Retrying would re-write the same change up to MAX_ATTEMPTS and then
    // report a bogus 409.
    const mergeBranch = vi.fn().mockResolvedValue({ merged: false, pullRequestUrl: 'https://github.com/x/y/pull/1' })
    const git = {
      readFile: vi.fn().mockResolvedValue(VOCAB_JSON),
      applyPlan: vi.fn().mockResolvedValue({ sha: 'commit-1' }),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    }
    stubCommonGlobals({ mergeBranch }, git)

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/vocabulary', handler: await loadVocabularyPatchHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/vocabulary', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ terms: { cta: { en: 'Get started' } } }),
      })

      expect(response.status).toBe(200)
      expect(git.applyPlan).toHaveBeenCalledTimes(1)
      expect(git.deleteBranch).not.toHaveBeenCalled()
    })
  })

  it('propagates non-conflict merge failures unchanged', async () => {
    const mergeBranch = vi.fn().mockRejectedValue(Object.assign(new Error('Bad credentials'), { status: 401 }))
    const git = {
      readFile: vi.fn().mockResolvedValue(VOCAB_JSON),
      applyPlan: vi.fn().mockResolvedValue({ sha: 'commit-1' }),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    }
    stubCommonGlobals({ mergeBranch }, git)

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/vocabulary', handler: await loadVocabularyPatchHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/vocabulary', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ terms: { cta: { en: 'Get started' } } }),
      })

      // h3 maps the error's own status through; the point is that it is
      // NOT swallowed into the conflict-retry path.
      expect(response.status).toBe(401)
      expect(git.applyPlan).toHaveBeenCalledTimes(1)
      expect(git.deleteBranch).not.toHaveBeenCalled()
    })
  })
})
