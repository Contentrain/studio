import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadContentPostHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/content/[modelId].post')).default
}

async function loadContentStatusHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/content/[modelId]/status.patch')).default
}

describe('content route integration', () => {
  it('saves content only for users with save_content permission and tracks media usage non-fatally', async () => {
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true, sha: 'merge-sha', pullRequestUrl: null })
    const saveContent = vi.fn().mockResolvedValue({
      branch: 'cr/content/posts/en/1234567890-abcd',
      commit: { sha: 'abc' },
      diff: [],
      validation: { valid: true, errors: [] },
    })
    const listAssets = vi.fn().mockResolvedValue({
      assets: [{ id: 'asset-1' }],
      total: 1,
    })
    const trackMediaUsage = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'modelId') return 'posts'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'editor-1', email: 'editor@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      workspaceRole: 'editor',
      availableTools: ['save_content'],
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {},
      contentRoot: '',
      workspace: { plan: 'free' },
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('free'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { workflow: 'auto-merge' } }))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({ saveContent, mergeBranch }))
    vi.stubGlobal('useMediaProvider', vi.fn().mockReturnValue({ listAssets }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      trackMediaUsage,
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/content/posts', handler: await loadContentPostHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/content/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locale: 'en',
          data: {
            entry1: {
              title: 'Hello world',
              heroImage: 'media/hero.png',
            },
          },
        }),
      })

      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload.branch).toBe('cr/content/posts/en/1234567890-abcd')
      expect(payload.merged).toBe(true)
      expect(payload.workflow).toBe('auto-merge')
      expect(saveContent).toHaveBeenCalledWith('posts', 'en', {
        entry1: {
          title: 'Hello world',
          heroImage: 'media/hero.png',
        },
      }, 'editor@example.com')
      expect(mergeBranch).toHaveBeenCalledWith('cr/content/posts/en/1234567890-abcd')
      expect(trackMediaUsage).toHaveBeenCalledWith({
        asset_id: 'asset-1',
        project_id: 'project-1',
        model_id: 'posts',
        entry_id: 'entry1',
        field_id: 'heroImage',
        locale: 'en',
      })
    })
  })

  it('only allows workspace owner/admin to publish content statuses', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'modelId') return 'posts'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'editor-1', email: 'editor@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      workspaceRole: 'member',
      availableTools: ['save_content'],
      specificModels: false,
      allowedModels: [],
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/content/posts/status', handler: await loadContentStatusHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/content/posts/status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entryIds: ['entry1'],
          status: 'published',
        }),
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 403,
      })
    })
  })

  it('updates entry statuses and auto-merges the generated branch', async () => {
    const updateEntryStatus = vi.fn().mockResolvedValue({
      branch: 'cr/content/posts/en/1234567890-efgh',
    })
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true })

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'modelId') return 'posts'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'owner-1', email: 'owner@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      workspaceRole: 'owner',
      availableTools: ['save_content'],
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {},
      contentRoot: '',
    }))
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({
      updateEntryStatus,
      mergeBranch,
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/content/posts/status', handler: await loadContentStatusHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/content/posts/status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locale: 'en',
          entryIds: ['entry1'],
          status: 'published',
        }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        merged: true,
        status: 'published',
        entryIds: ['entry1'],
      })
      expect(updateEntryStatus).toHaveBeenCalledWith('posts', 'en', ['entry1'], 'published', 'owner@example.com')
      expect(mergeBranch).toHaveBeenCalledWith('cr/content/posts/en/1234567890-efgh')
    })
  })
})
