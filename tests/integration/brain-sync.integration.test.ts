import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadBrainSyncHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/brain/sync.get')).default
}

describe('brain sync integration', () => {
  it('returns an empty delta when the client treeSha matches the cache', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('getQuery', vi.fn().mockReturnValue({ treeSha: 'tree-1' }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('requireProjectAccess', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {},
      contentRoot: '',
    }))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
      treeSha: 'tree-1',
      config: { locales: { default: 'en', supported: ['en'] } },
      models: new Map(),
      content: new Map(),
      meta: new Map(),
      vocabulary: null,
      contentContext: null,
      contentSummary: {},
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/brain/sync', handler: await loadBrainSyncHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/brain/sync?treeSha=tree-1')

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        treeSha: 'tree-1',
        delta: true,
        config: null,
        models: null,
        content: null,
        vocabulary: null,
        contentContext: null,
        contentSummary: null,
      })
    })
  })

  it('serializes brain cache maps into full sync payloads', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('getQuery', vi.fn().mockReturnValue({}))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('requireProjectAccess', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {},
      contentRoot: '',
    }))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
      treeSha: 'tree-2',
      config: { locales: { default: 'en', supported: ['en', 'tr'] } },
      models: new Map([
        ['posts', { id: 'posts', name: 'Posts', kind: 'collection', i18n: true }],
      ]),
      content: new Map([
        ['posts:en', { entry1: { title: 'Hello' } }],
      ]),
      meta: new Map([
        ['posts:en', { entry1: { status: 'draft' } }],
      ]),
      vocabulary: { terms: { headline: { en: 'Headline' } } },
      contentContext: { stats: { entries: 1 } },
      contentSummary: {
        posts: { kind: 'collection', count: 1, locales: ['en'] },
      },
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/brain/sync', handler: await loadBrainSyncHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/brain/sync')

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        treeSha: 'tree-2',
        delta: false,
        config: { locales: { default: 'en', supported: ['en', 'tr'] } },
        models: {
          posts: { id: 'posts', name: 'Posts', kind: 'collection', i18n: true },
        },
        content: {
          'posts:en': {
            data: { entry1: { title: 'Hello' } },
            meta: { entry1: { status: 'draft' } },
            kind: 'collection',
          },
        },
        vocabulary: { terms: { headline: { en: 'Headline' } } },
        contentContext: { stats: { entries: 1 } },
        contentSummary: {
          posts: { kind: 'collection', count: 1, locales: ['en'] },
        },
      })
    })
  })
})
