import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadMediaListHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/media/index.get')).default
}

async function loadMediaUploadHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/media/index.post')).default
}

async function loadMediaUploadUrlHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/media/upload-url.post')).default
}

async function loadMediaBulkHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/media/bulk.post')).default
}

async function loadMediaAssetHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/media/[assetId].get')).default
}

async function loadMediaPatchHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/media/[assetId].patch')).default
}

async function loadMediaDeleteHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/media/[assetId].delete')).default
}

async function loadMediaPreviewHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/media/[assetId]/preview.get')).default
}

const sampleAsset = {
  id: 'asset-1',
  projectId: 'project-1',
  filename: 'hero.png',
  contentType: 'image/png',
  size: 2048,
  width: 1200,
  height: 630,
  format: 'png',
  blurhash: null,
  alt: 'Hero',
  focalPoint: null,
  variants: {
    thumb: {
      path: 'media/thumb.png',
      width: 320,
      height: 180,
      format: 'png',
      size: 512,
    },
  },
  tags: ['hero'],
  uploadedBy: 'user-1',
  source: 'upload' as const,
  originalPath: 'media/original.png',
  contentHash: 'hash-1',
  usedIn: [],
  createdAt: '2026-03-26T00:00:00.000Z',
  updatedAt: '2026-03-26T00:00:00.000Z',
}

function stubMediaRouteGlobals() {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'workspaceId') return 'workspace-1'
    if (key === 'projectId') return 'project-1'
    if (key === 'assetId') return 'asset-1'
    return undefined
  }))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
    user: { id: 'user-1' },
    accessToken: 'token-1',
  }))
  vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
  vi.stubGlobal('requireWorkspaceRole', vi.fn().mockResolvedValue('owner'))
}

describe('media route integration', () => {
  it('lists assets with the requested filters for plans with media access', async () => {
    const listAssets = vi.fn().mockResolvedValue({ assets: [sampleAsset], total: 1 })

    stubMediaRouteGlobals()
    vi.stubGlobal('getWorkspace', vi.fn().mockResolvedValue({ plan: 'pro' }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('useMediaProvider', vi.fn().mockReturnValue({ listAssets }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/media', handler: await loadMediaListHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/media?search=hero&tags=marketing,homepage&type=image/png&page=2&limit=25&sort=name')

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ assets: [sampleAsset], total: 1 })
      expect(listAssets).toHaveBeenCalledWith('project-1', {
        search: 'hero',
        tags: ['marketing', 'homepage'],
        contentType: 'image/png',
        page: 2,
        limit: 25,
        sort: 'name',
      })
    })
  })

  it('uploads multipart media files through the media provider', async () => {
    stubMediaRouteGlobals()
    vi.stubGlobal('getWorkspace', vi.fn().mockResolvedValue({ plan: 'pro' }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('isAllowedMimeType', vi.fn().mockReturnValue(true))
    vi.stubGlobal('getPlanLimit', vi.fn((_: string, limit: string) => limit === 'media.storage_gb' ? 5 : 10))
    vi.stubGlobal('resolveVariantConfig', vi.fn().mockReturnValue({
      default: { width: 1200, fit: 'inside' },
    }))
    vi.stubGlobal('readMultipartFormData', vi.fn().mockResolvedValue([
      {
        name: 'file',
        filename: 'hero.png',
        type: 'image/png',
        data: Buffer.from('png-bytes'),
      },
      {
        name: 'alt',
        data: Buffer.from('Hero image'),
      },
      {
        name: 'tags',
        data: Buffer.from('marketing,homepage'),
      },
    ]))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: { media_storage_bytes: 1024 },
            }),
          })),
        })),
      })),
    }))
    const upload = vi.fn().mockResolvedValue(sampleAsset)
    vi.stubGlobal('useMediaProvider', vi.fn().mockReturnValue({ upload }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/media', handler: await loadMediaUploadHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/media', {
        method: 'POST',
      })

      expect([200, 201]).toContain(response.status)
      await expect(response.json()).resolves.toEqual(sampleAsset)
      expect(upload).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        filename: 'hero.png',
        contentType: 'image/png',
        alt: 'Hero image',
        tags: ['marketing', 'homepage'],
      }))
    })
  })

  it('imports media from external URLs through the same upload pipeline', async () => {
    stubMediaRouteGlobals()
    vi.stubGlobal('getWorkspace', vi.fn().mockResolvedValue({ plan: 'pro' }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('isAllowedMimeType', vi.fn().mockReturnValue(true))
    vi.stubGlobal('getPlanLimit', vi.fn().mockReturnValue(10))
    vi.stubGlobal('resolveVariantConfig', vi.fn().mockReturnValue({
      default: { width: 1200, fit: 'inside' },
    }))
    const upload = vi.fn().mockResolvedValue(sampleAsset)
    vi.stubGlobal('useMediaProvider', vi.fn().mockReturnValue({ upload }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      url: 'https://example.com/file.png',
      alt: 'Imported hero',
      tags: ['imported'],
    }))
    const setResponseStatus = vi.fn()
    vi.stubGlobal('setResponseStatus', setResponseStatus)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    }))

    const handler = await loadMediaUploadUrlHandler()
    const result = await handler({} as never)

    expect(result).toEqual(sampleAsset)
    expect(setResponseStatus).toHaveBeenCalledWith({}, 201)
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      filename: 'file.png',
      alt: 'Imported hero',
      tags: ['imported'],
      contentType: 'image/png',
    }))
  })

  it('supports bulk delete and bulk tag operations inside the current project', async () => {
    const getAsset = vi.fn()
      .mockResolvedValueOnce(sampleAsset)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sampleAsset)
    const deleteAsset = vi.fn().mockResolvedValue(undefined)
    const updateMetadata = vi.fn().mockResolvedValue(sampleAsset)

    stubMediaRouteGlobals()
    vi.stubGlobal('useMediaProvider', vi.fn().mockReturnValue({
      getAsset,
      delete: deleteAsset,
      updateMetadata,
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/media/bulk-delete', handler: await loadMediaBulkHandler() },
        { path: '/api/workspaces/workspace-1/projects/project-1/media/bulk-tag', handler: await loadMediaBulkHandler() },
      ],
    }, async ({ request }) => {
      const deleteResponse = await request('/api/workspaces/workspace-1/projects/project-1/media/bulk-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          assetIds: ['asset-1', 'asset-missing'],
        }),
      })

      expect(deleteResponse.status).toBe(200)
      await expect(deleteResponse.json()).resolves.toEqual({
        results: [
          { id: 'asset-1', success: true },
          { id: 'asset-missing', success: false, error: 'Not found' },
        ],
      })

      const tagResponse = await request('/api/workspaces/workspace-1/projects/project-1/media/bulk-tag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'tag',
          assetIds: ['asset-1'],
          tags: ['homepage'],
        }),
      })

      expect(tagResponse.status).toBe(200)
      await expect(tagResponse.json()).resolves.toEqual({
        results: [
          { id: 'asset-1', success: true },
        ],
      })
      expect(updateMetadata).toHaveBeenCalledWith('asset-1', {
        tags: ['hero', 'homepage'],
      })
    })
  })

  it('returns 404 for media assets that do not belong to the project', async () => {
    stubMediaRouteGlobals()
    vi.stubGlobal('getWorkspace', vi.fn().mockResolvedValue({ plan: 'pro' }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('useMediaProvider', vi.fn().mockReturnValue({
      getAsset: vi.fn().mockResolvedValue({ ...sampleAsset, projectId: 'project-foreign' }),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/media/asset-1', handler: await loadMediaAssetHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/media/asset-1')

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 404,
      })
    })
  })

  it('updates and deletes media metadata only after verifying project ownership', async () => {
    const updateMetadata = vi.fn().mockResolvedValue({
      ...sampleAsset,
      alt: 'Updated hero',
      tags: ['hero', 'homepage'],
    })
    const deleteAsset = vi.fn().mockResolvedValue(undefined)

    stubMediaRouteGlobals()
    vi.stubGlobal('useMediaProvider', vi.fn().mockReturnValue({
      getAsset: vi.fn().mockResolvedValue(sampleAsset),
      updateMetadata,
      delete: deleteAsset,
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/media/asset-1', handler: await loadMediaPatchHandler() },
      ],
    }, async ({ request }) => {
      const patchResponse = await request('/api/workspaces/workspace-1/projects/project-1/media/asset-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          alt: 'Updated hero',
          tags: ['hero', 'homepage'],
        }),
      })

      expect(patchResponse.status).toBe(200)
      await expect(patchResponse.json()).resolves.toEqual({
        ...sampleAsset,
        alt: 'Updated hero',
        tags: ['hero', 'homepage'],
      })
    })

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/media/asset-1', handler: await loadMediaDeleteHandler() },
      ],
    }, async ({ request }) => {
      const deleteResponse = await request('/api/workspaces/workspace-1/projects/project-1/media/asset-1', {
        method: 'DELETE',
      })

      expect(deleteResponse.status).toBe(200)
      await expect(deleteResponse.json()).resolves.toEqual({ deleted: true })
      expect(deleteAsset).toHaveBeenCalledWith('project-1', 'asset-1')
    })
  })

  it('streams preview binaries through the storage provider with cache headers', async () => {
    stubMediaRouteGlobals()
    vi.stubGlobal('useMediaProvider', vi.fn().mockReturnValue({
      getAsset: vi.fn().mockResolvedValue(sampleAsset),
    }))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({
      getObject: vi.fn().mockResolvedValue({
        data: Buffer.from('preview-bytes'),
        contentType: 'image/png',
        etag: 'etag-1',
      }),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/media/asset-1/preview', handler: await loadMediaPreviewHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/media/asset-1/preview?variant=thumb')

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(response.headers.get('cache-control')).toBe('private, max-age=3600')
      expect(response.headers.get('etag')).toBe('etag-1')
      expect(await response.text()).toBe('preview-bytes')
    })
  })
})
