import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadContentGetHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/content/[modelId].get')).default
}

async function loadContentPostHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/content/[modelId].post')).default
}

async function loadContentStatusHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/content/[modelId]/status.patch')).default
}

describe('content route integration', () => {
  it('blocks model reads outside the allowed specificModels set', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'modelId') return 'posts'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'viewer-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      specificModels: true,
      allowedModels: ['pages'],
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/content/posts', handler: await loadContentGetHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/content/posts')

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 403,
      })
    })
  })

  it('reads collection content via the resolved project context and content paths', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'modelId') return 'posts'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'editor-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveModelPath', vi.fn().mockReturnValue('.contentrain/models/posts.json'))
    vi.stubGlobal('resolveContentPath', vi.fn().mockReturnValue('.contentrain/content/blog/posts/en.json'))
    vi.stubGlobal('resolveMetaPath', vi.fn().mockReturnValue('.contentrain/meta/blog/posts/en.json'))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      contentRoot: '',
      git: {
        readFile: vi.fn((path: string) => {
          if (path === '.contentrain/models/posts.json') {
            return JSON.stringify({
              id: 'posts',
              domain: 'blog',
              kind: 'collection',
              i18n: true,
            })
          }
          if (path === '.contentrain/content/blog/posts/en.json') {
            return JSON.stringify({
              entry1: { title: 'Hello world' },
            })
          }
          if (path === '.contentrain/meta/blog/posts/en.json') {
            return JSON.stringify({
              entry1: { status: 'draft' },
            })
          }
          throw new Error(`Unexpected read: ${path}`)
        }),
      },
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/content/posts', handler: await loadContentGetHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/content/posts?locale=en')

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        modelId: 'posts',
        locale: 'en',
        kind: 'collection',
        data: {
          entry1: { title: 'Hello world' },
        },
        meta: {
          entry1: { status: 'draft' },
        },
      })
    })
  })

  it('saves content only for users with save_content permission and tracks media usage non-fatally', async () => {
    const saveContent = vi.fn().mockResolvedValue({
      branch: 'contentrain/save-123',
      saved: true,
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
      availableTools: ['save_content'],
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {},
      contentRoot: '',
    }))
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({ saveContent }))
    vi.stubGlobal('useMediaProvider', vi.fn().mockReturnValue({ listAssets }))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({}))
    vi.stubGlobal('trackMediaUsage', trackMediaUsage)

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
      await expect(response.json()).resolves.toEqual({
        branch: 'contentrain/save-123',
        saved: true,
      })
      expect(saveContent).toHaveBeenCalledWith('posts', 'en', {
        entry1: {
          title: 'Hello world',
          heroImage: 'media/hero.png',
        },
      }, 'editor@example.com')
      expect(trackMediaUsage).toHaveBeenCalledWith({}, {
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
      branch: 'contentrain/status-123',
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
      expect(mergeBranch).toHaveBeenCalledWith('contentrain/status-123')
    })
  })
})
