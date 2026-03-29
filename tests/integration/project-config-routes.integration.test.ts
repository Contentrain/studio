import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

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
    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({
      from: vi.fn(() => ({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'project-1',
                status: 'setup',
                content_root: '/',
              },
              error: null,
            }),
          })),
        })),
      })),
    }))

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
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: 'project-1',
                  project_members: [{ id: 'pm-1', role: 'editor' }],
                },
                error: null,
              }),
            })),
          })),
        })),
      })),
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
      workspace: { plan: 'business' },
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('business'))
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
    const createBranch = vi.fn().mockResolvedValue(undefined)
    const commitFiles = vi.fn().mockResolvedValue(undefined)
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true })

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
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      availableTools: ['save_content'],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {
        readFile: vi.fn((path: string, ref?: string) => {
          if (path === '.contentrain/vocabulary.json') {
            return JSON.stringify({
              version: 1,
              terms: { headline: { en: 'Headline' } },
            })
          }
          if (path === 'content/posts/en.json' && ref === 'contentrain') return JSON.stringify({ before: true })
          if (path === 'content/posts/en.json' && ref === 'cr/content/faq/en/1234567890-abcd') return JSON.stringify({ after: true })
          throw new Error(`Unexpected read: ${path}`)
        }),
        createBranch,
        commitFiles,
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
})
