import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'
import { ensureContentBranch } from '../../server/utils/ensure-content-branch'

async function loadProjectCreateHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/index.post')).default
}

async function loadProjectGetHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/index.get')).default
}

async function loadConfigPatchHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/config.patch')).default
}

async function loadVocabularyPatchHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/vocabulary.patch')).default
}

async function loadBranchesHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/index.get')).default
}

async function loadBranchDiffHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/diff.get')).default
}

describe('project config and branch route integration', () => {
  it('creates projects with setup status when the repository is not initialized', async () => {
    const createBranch = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
      getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'workspace-1', plan: 'starter', github_installation_id: 123 }),
      getWorkspaceById: vi.fn().mockResolvedValue({ id: 'workspace-1', github_installation_id: 123 }),
      checkDuplicateProject: vi.fn().mockResolvedValue(false),
      createProject: vi.fn().mockResolvedValue({ id: 'project-1', status: 'setup', content_root: '/' }),
    }))
    vi.stubGlobal('useGitProvider', vi.fn().mockReturnValue({
      listBranches: vi.fn().mockResolvedValue([]),
      createBranch,
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
    }))
    // Real helper against the stubbed provider — the route reaches it through
    // Nitro auto-import, which this harness resolves via globals.
    vi.stubGlobal('ensureContentBranch', ensureContentBranch)

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects', handler: await loadProjectCreateHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoFullName: 'acme/site',
          hasContentrain: false,
        }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        id: 'project-1',
        status: 'setup',
        content_root: '/',
      })

      // A stored project must imply a write-ready one: the content SSOT
      // branch is established before the row exists, otherwise reads and
      // /health look healthy while every write dies on the missing base ref.
      expect(createBranch).toHaveBeenCalledWith('contentrain', 'main')
    })
  })

  it('loads a project with nested membership details', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getProjectWithMembers: vi.fn().mockResolvedValue({
        id: 'project-1',
        project_members: [{ id: 'pm-1', role: 'editor' }],
      }),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1', handler: await loadProjectGetHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1')

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        id: 'project-1',
        project_members: [{ id: 'pm-1', role: 'editor' }],
      })
    })
  })

  it('patches project config and auto-merges through the content engine', async () => {
    const createBranch = vi.fn().mockResolvedValue(undefined)
    const commitFiles = vi.fn().mockResolvedValue(undefined)
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true, pullRequestUrl: null })

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'owner-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      workspaceRole: 'owner',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {
        readFile: vi.fn().mockResolvedValue(JSON.stringify({
          workflow: 'auto-merge',
          domains: ['marketing'],
          locales: { default: 'en', supported: ['en'] },
        })),
        createBranch,
        commitFiles,
      },
      contentRoot: '',
      workspace: { plan: 'pro' },
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('generateBranchName', vi.fn().mockReturnValue('cr/content/config/1234567890-abcd'))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({ ensureContentBranch: vi.fn().mockResolvedValue(undefined), mergeBranch }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/config', handler: await loadConfigPatchHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflow: 'review' }),
      })

      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload.merged).toBe(true)
      expect(payload.config.workflow).toBe('review')
      expect(createBranch).toHaveBeenCalledOnce()
      expect(commitFiles).toHaveBeenCalledOnce()
    })
  })

  it('merges vocabulary updates and loads pending branch diffs', async () => {
    // A tiny stateful git: applyPlan stages the write, mergeBranch lands it.
    // The endpoint verifies its write by re-reading `contentrain`, so a mock
    // that ignores what was committed would fail that check — which is the
    // point, since the bug this endpoint guards against is a write that
    // merges and still doesn't land.
    let vocabularyOnContentrain = JSON.stringify({
      version: 1,
      terms: { headline: { en: 'Headline' } },
    })
    const staged = new Map<string, string>()

    const applyPlan = vi.fn(async ({ branch, changes }: { branch: string, changes: { path: string, content: string }[] }) => {
      for (const change of changes) staged.set(`${branch}:${change.path}`, change.content)
      return { sha: 'commit-sha' }
    })
    const mergeBranch = vi.fn(async (branch: string) => {
      const content = staged.get(`${branch}:.contentrain/vocabulary.json`)
      if (content !== undefined) vocabularyOnContentrain = content
      return { merged: true }
    })
    const deleteBranch = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'branch') return 'cr/content/faq/en/1234567890-abcd'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'editor-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('requireProjectAccess', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['save_content'],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {
        readFile: vi.fn((path: string, ref?: string) => {
          if (path === '.contentrain/vocabulary.json') return vocabularyOnContentrain
          if (path === 'content/posts/en.json' && ref === 'contentrain') return JSON.stringify({ before: true })
          if (path === 'content/posts/en.json' && ref === 'cr/content/faq/en/1234567890-abcd') return JSON.stringify({ after: true })
          throw new Error(`Unexpected read: ${path}`)
        }),
        applyPlan,
        deleteBranch,
        listBranches: vi.fn().mockResolvedValue([{ name: 'cr/content/faq/en/1234567890-abcd', sha: 'abc', protected: false }]),
        getBranchDiff: vi.fn().mockResolvedValue([
          { path: 'content/posts/en.json', status: 'modified' },
        ]),
        getDefaultBranch: vi.fn().mockResolvedValue('main'),
      },
      contentRoot: '',
    }))
    vi.stubGlobal('generateBranchName', vi.fn().mockReturnValue('cr/content/vocabulary/1234567890-abcd'))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({ ensureContentBranch: vi.fn().mockResolvedValue(undefined), mergeBranch }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/vocabulary', handler: await loadVocabularyPatchHandler() },
        { path: '/api/workspaces/workspace-1/projects/project-1/branches/cr/content/faq/en/1234567890-abcd/diff', handler: await loadBranchDiffHandler() },
        { path: '/api/workspaces/workspace-1/projects/project-1/branches', handler: await loadBranchesHandler() },
      ],
    }, async ({ request }) => {
      const vocabResponse = await request('/api/workspaces/workspace-1/projects/project-1/vocabulary', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          terms: {
            headline: { tr: 'Baslik' },
            cta: { en: 'Start now' },
          },
        }),
      })

      expect(vocabResponse.status).toBe(200)
      const vocabPayload = await vocabResponse.json()
      expect(vocabPayload.merged).toBe(true)
      expect(vocabPayload.vocabulary.terms).toEqual({
        headline: { en: 'Headline', tr: 'Baslik' },
        cta: { en: 'Start now' },
      })

      const branchesResponse = await request('/api/workspaces/workspace-1/projects/project-1/branches')
      expect(branchesResponse.status).toBe(200)
      await expect(branchesResponse.json()).resolves.toEqual({
        branches: [{ name: 'cr/content/faq/en/1234567890-abcd', sha: 'abc', protected: false }],
      })

      const diffResponse = await request('/api/workspaces/workspace-1/projects/project-1/branches/cr/content/faq/en/1234567890-abcd/diff')
      expect(diffResponse.status).toBe(200)
      const diffPayload = await diffResponse.json()
      expect(diffPayload.branch).toBe('cr/content/faq/en/1234567890-abcd')
      expect(diffPayload.contents['content/posts/en.json']).toEqual({
        before: { before: true },
        after: { after: true },
      })
    })
  })

  it('retries a vocabulary save whose term a concurrent writer overwrote', async () => {
    // The reported bug: two saves fork the same `contentrain` commit, each
    // writes the whole file from that base, and the last merge wins — dropping
    // the other's term while both report success. Here the first merge lands
    // and is then clobbered by a concurrent snapshot; the endpoint must notice
    // and retry rather than report a save that isn't there.
    let vocabularyOnContentrain = JSON.stringify({ version: 1, terms: {} })
    const staged = new Map<string, string>()
    let merges = 0

    const applyPlan = vi.fn(async ({ branch, changes }: { branch: string, changes: { path: string, content: string }[] }) => {
      for (const change of changes) staged.set(`${branch}:${change.path}`, change.content)
      return { sha: 'commit-sha' }
    })
    const mergeBranch = vi.fn(async (branch: string) => {
      merges += 1
      const content = staged.get(`${branch}:.contentrain/vocabulary.json`)
      if (content !== undefined) vocabularyOnContentrain = content
      // A racing writer lands right after the first merge, replacing the file
      // with a snapshot built from the same stale base.
      if (merges === 1) {
        vocabularyOnContentrain = JSON.stringify({ version: 1, terms: { other: { en: 'Other' } } })
      }
      return { merged: true }
    })
    const deleteBranch = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'editor-1' }, accessToken: 'token-1' }))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({ availableTools: ['save_content'] }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {
        readFile: vi.fn((path: string) => {
          if (path === '.contentrain/vocabulary.json') return vocabularyOnContentrain
          throw new Error(`Unexpected read: ${path}`)
        }),
        applyPlan,
        deleteBranch,
      },
      contentRoot: '',
    }))
    vi.stubGlobal('generateBranchName', vi.fn(() => `cr/content/vocabulary/${merges}-abcd`))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({
      ensureContentBranch: vi.fn().mockResolvedValue(undefined),
      mergeBranch,
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/vocabulary', handler: await loadVocabularyPatchHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/vocabulary', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ terms: { brand: { tr: 'Collabers' } } }),
      })

      expect(response.status).toBe(200)
      const payload = await response.json()
      // Our term survived, and the concurrent writer's term was not trampled.
      expect(payload.vocabulary.terms.brand).toEqual({ tr: 'Collabers' })
      expect(payload.vocabulary.terms.other).toEqual({ en: 'Other' })
      expect(merges).toBe(2)
    })
  })
})
