import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadVocabularyPatchHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/vocabulary.patch')).default
}

const VOCAB_JSON = JSON.stringify({ version: 1, terms: { cta: { en: 'Get started' } } })

function stubCommonGlobals(overrides: { mergeBranch: ReturnType<typeof vi.fn>, snapshots?: string[] }, git: Record<string, unknown>) {
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
  // Each attempt pins its read and its fork to the `contentrain` head of that
  // moment; `snapshots` hands out one sha per attempt.
  const snapshots = overrides.snapshots ?? ['snap-1', 'snap-2', 'snap-3']
  let attempt = 0
  vi.stubGlobal('openWriteSnapshot', vi.fn(async () => ({ baseSha: snapshots[attempt++] ?? null, reader: {} })))
  vi.stubGlobal('writeBase', (snapshot: { baseSha: string | null }) => snapshot.baseSha ?? 'contentrain')
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

  it('reads and forks from one contentrain commit, and verifies on the live branch (#285)', async () => {
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true, sha: 'sha-2', pullRequestUrl: null })
    const landed = JSON.stringify({ version: 1, terms: { cta: { en: 'Get started' }, signup: { en: 'Sign up' } } })
    const git = {
      readFile: vi.fn(async (_path: string, ref: string) => (ref === 'contentrain' ? landed : VOCAB_JSON)),
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
        body: JSON.stringify({ terms: { signup: { en: 'Sign up' } } }),
      })

      expect(response.status).toBe(200)
      // Read at the snapshot, forked from the snapshot — not from wherever
      // `contentrain` points by the time the commit is written.
      expect(git.readFile.mock.calls[0]).toEqual(['.contentrain/vocabulary.json', 'snap-1'])
      expect(git.applyPlan).toHaveBeenCalledWith(expect.objectContaining({ base: 'snap-1' }))
      // The check that the term survived reads the live branch.
      expect(git.readFile.mock.calls.at(-1)).toEqual(['.contentrain/vocabulary.json', 'contentrain'])
    })
  })

  it('keeps a term another writer landed after the read: the conflict is retried from a fresh snapshot', async () => {
    // Writer B adds `pricing` after this request read snap-1. The branch forks
    // from snap-1, so git sees two edits of one file and the merge conflicts
    // rather than quietly reverting `pricing`. The retry reads snap-2, which
    // has it, and writes both terms.
    const withPricing = JSON.stringify({ version: 1, terms: { cta: { en: 'Get started' }, pricing: { en: 'Pricing' } } })
    const mergeBranch = vi.fn()
      .mockResolvedValueOnce({ merged: false, sha: null, pullRequestUrl: null, conflict: true })
      .mockResolvedValueOnce({ merged: true, sha: 'sha-3', pullRequestUrl: null })
    const landed = JSON.stringify({ version: 1, terms: { cta: { en: 'Get started' }, pricing: { en: 'Pricing' }, signup: { en: 'Sign up' } } })
    const git = {
      readFile: vi.fn(async (_path: string, ref: string) => (ref === 'snap-1' ? VOCAB_JSON : ref === 'snap-2' ? withPricing : landed)),
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
        body: JSON.stringify({ terms: { signup: { en: 'Sign up' } } }),
      })

      expect(response.status).toBe(200)
      expect(git.deleteBranch).toHaveBeenCalledTimes(1)
      expect(git.applyPlan).toHaveBeenCalledTimes(2)
      const second = git.applyPlan.mock.calls[1]![0] as { base: string, changes: Array<{ content: string }> }
      expect(second.base).toBe('snap-2')
      expect(JSON.parse(second.changes[0]!.content).terms).toEqual({
        cta: { en: 'Get started' },
        pricing: { en: 'Pricing' },
        signup: { en: 'Sign up' },
      })
    })
  })

  it('retries from a fresh snapshot when applyPlan refuses a stale base (409)', async () => {
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true, sha: 'sha-2', pullRequestUrl: null })
    const git = {
      readFile: vi.fn().mockResolvedValue(VOCAB_JSON),
      applyPlan: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('Branch moved away from base'), { status: 409 }))
        .mockResolvedValueOnce({ sha: 'commit-2' }),
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
      expect(git.applyPlan.mock.calls.map(c => (c[0] as { base: string }).base)).toEqual(['snap-1', 'snap-2'])
      expect(mergeBranch).toHaveBeenCalledTimes(1)
    })
  })
})
