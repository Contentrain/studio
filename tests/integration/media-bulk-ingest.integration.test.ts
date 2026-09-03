import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/media/bulk-ingest.post')).default
}

function stubGlobals(role = 'owner') {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'workspaceId') return 'workspace-1'
    if (key === 'projectId') return 'project-1'
    return undefined
  }))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'user-1' }, accessToken: 'token-1' }))
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  vi.stubGlobal('getUpgradeParams', vi.fn().mockReturnValue({}))
  vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
    requireWorkspaceRole: vi.fn().mockResolvedValue(role),
    getProjectForWorkspace: vi.fn().mockResolvedValue({ id: 'project-1' }),
    getProjectMember: vi.fn().mockResolvedValue({ id: 'pm-1' }),
    getWorkspaceById: vi.fn().mockResolvedValue({ plan: 'pro' }),
  }))
}

describe('media bulk-ingest route', () => {
  it('validates the item list and forwards clean items to the ingester', async () => {
    stubGlobals()
    const ingestMediaUrls = vi.fn().mockResolvedValue({ requested: 2, unique: 2, succeeded: 2, failed: 0, results: [], map: {} })
    vi.doMock('../../server/utils/media-bulk-ingest', () => ({ BULK_INGEST_MAX_ITEMS: 100, ingestMediaUrls }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/media/bulk-ingest', handler: await loadHandler() }],
    }, async ({ request }) => {
      const empty = await request('/api/workspaces/workspace-1/projects/project-1/media/bulk-ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [] }),
      })
      expect(empty.status).toBe(400)

      const tooMany = await request('/api/workspaces/workspace-1/projects/project-1/media/bulk-ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: Array.from({ length: 101 }, (_, i) => ({ url: `https://old.example/${i}.jpg` })) }),
      })
      expect(tooMany.status).toBe(400)

      const ok = await request('/api/workspaces/workspace-1/projects/project-1/media/bulk-ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ url: 'https://old.example/a.jpg', alt: 'A', tags: ['hero', 7] }, { url: 'https://old.example/b.jpg' }, { nope: true }], concurrency: 9 }),
      })
      expect(ok.status).toBe(200)
      expect(ingestMediaUrls).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        uploadedBy: 'user-1',
        source: 'url',
        concurrency: 9,
        items: [
          { url: 'https://old.example/a.jpg', alt: 'A', tags: ['hero'], filename: undefined },
          { url: 'https://old.example/b.jpg', alt: undefined, tags: undefined, filename: undefined },
        ],
      }))
    })
    vi.doUnmock('../../server/utils/media-bulk-ingest')
  })

  it('is refused without media.upload on the plan', async () => {
    stubGlobals()
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/media/bulk-ingest', handler: await loadHandler() }],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/media/bulk-ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ url: 'https://old.example/a.jpg' }] }),
      })
      expect(response.status).toBe(403)
    })
  })
})
