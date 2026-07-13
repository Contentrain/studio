import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * MCP media facet — the RepoProvider.media passthrough over Studio's media
 * stack. Pins the contract mapping, opaque cursor, tenant isolation, and
 * the ingest quota dance (reserve → upload → reconcile / release).
 */

const state = vi.hoisted(() => ({
  mediaProvider: null as Record<string, ReturnType<typeof vi.fn>> | null,
  fetchRemoteMedia: vi.fn(),
  reserveResult: { allowed: true, currentBytes: 0 },
  workspace: { id: 'ws-1', overage_settings: {} as Record<string, boolean> } as Record<string, unknown> | null,
  reserveStorageIfAllowed: vi.fn(),
  incrementWorkspaceStorageBytes: vi.fn(),
  getWorkspaceById: vi.fn(),
  emitWebhookEvent: vi.fn(),
  planLimits: { 'media.max_file_size_mb': 50, 'media.storage_gb': 15, 'media.variants_per_field': 10 } as Record<string, number>,
  features: { 'media.custom_variants': false } as Record<string, boolean>,
}))

vi.mock('../../server/utils/media-ingest', () => ({
  fetchRemoteMedia: (...args: unknown[]) => state.fetchRemoteMedia(...args),
}))

// withMediaUrls + resolveVariantConfigWithPlan run for real (pure); only
// the remote fetch and the Nitro auto-imports are stubbed.

function studioAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-1',
    projectId: 'proj-1',
    filename: 'photo.webp',
    contentType: 'image/webp',
    size: 1234,
    width: 800,
    height: 600,
    format: 'webp',
    blurhash: 'LEHV6nWB',
    alt: 'a photo',
    focalPoint: null,
    variants: { thumb: { path: 'media/variants/asset-1-thumb.webp', width: 200, height: 150, format: 'webp', size: 300 } },
    tags: ['nature'],
    uploadedBy: 'owner-1',
    source: 'agent',
    originalPath: 'media/original/asset-1.webp',
    contentHash: 'abc',
    usedIn: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
    ...overrides,
  }
}

async function loadFacet() {
  const { buildMcpMediaFacet } = await import('../../server/utils/mcp-media-facet')
  return buildMcpMediaFacet({ projectId: 'proj-1', workspaceId: 'ws-1', uploadedBy: 'owner-1', plan: 'pro' })
}

describe('buildMcpMediaFacet', () => {
  beforeEach(() => {
    vi.resetModules()
    state.reserveResult = { allowed: true, currentBytes: 0 }
    state.workspace = { id: 'ws-1', overage_settings: {} }
    state.planLimits = { 'media.max_file_size_mb': 50, 'media.storage_gb': 15, 'media.variants_per_field': 10 }
    state.features = { 'media.custom_variants': false }

    state.mediaProvider = {
      listAssets: vi.fn(),
      getAsset: vi.fn(),
      upload: vi.fn(),
      updateMetadata: vi.fn(),
      delete: vi.fn(),
    }
    state.reserveStorageIfAllowed = vi.fn(async () => state.reserveResult)
    state.incrementWorkspaceStorageBytes = vi.fn(async () => {})
    state.getWorkspaceById = vi.fn(async () => state.workspace)
    state.emitWebhookEvent = vi.fn(async () => {})
    state.fetchRemoteMedia = vi.fn(async () => ({
      buffer: Buffer.alloc(2000),
      filename: 'remote.png',
      contentType: 'image/png',
    }))

    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => {
      const err = new Error(input.message) as Error & { statusCode: number }
      err.statusCode = input.statusCode
      return err
    })
    vi.stubGlobal('errorMessage', (key: string) => key)
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.example' } }))
    vi.stubGlobal('useMediaProvider', () => state.mediaProvider)
    vi.stubGlobal('useDatabaseProvider', () => ({
      getWorkspaceById: state.getWorkspaceById,
      reserveStorageIfAllowed: state.reserveStorageIfAllowed,
      incrementWorkspaceStorageBytes: state.incrementWorkspaceStorageBytes,
    }))
    vi.stubGlobal('getPlanLimit', (_plan: string, key: string) => state.planLimits[key] ?? 0)
    vi.stubGlobal('hasFeature', (_plan: string, key: string) => state.features[key] ?? false)
    vi.stubGlobal('getEffectiveLimit', (limit: number) => limit)
    vi.stubGlobal('emitWebhookEvent', state.emitWebhookEvent)
  })

  it('returns null when the media stack is unavailable', async () => {
    state.mediaProvider = null
    expect(await loadFacet()).toBeNull()
  })

  describe('list', () => {
    it('maps assets to the contract shape and pages via an opaque cursor', async () => {
      state.mediaProvider!.listAssets.mockResolvedValue({ assets: [studioAsset()], total: 120 })
      const facet = (await loadFacet())!

      const result = await facet.list({ limit: 50 })
      expect(state.mediaProvider!.listAssets).toHaveBeenCalledWith('proj-1', { search: undefined, tags: undefined, page: 1, limit: 50 })
      expect(result.total).toBe(120)
      expect(result.assets[0]).toMatchObject({
        id: 'asset-1',
        path: 'media/original/asset-1.webp',
        url: 'https://studio.example/api/cdn/v1/proj-1/media/original/asset-1.webp',
        mime: 'image/webp',
        size: 1234,
        alt: 'a photo',
        tags: ['nature'],
      })
      expect(result.assets[0]!.meta).toMatchObject({ width: 800, height: 600, blurhash: 'LEHV6nWB', filename: 'photo.webp' })
      expect(result.nextCursor).toBeDefined()

      // The cursor round-trips the page + limit it was minted with.
      const next = await facet.list({ cursor: result.nextCursor, limit: 5 })
      expect(state.mediaProvider!.listAssets).toHaveBeenLastCalledWith('proj-1', { search: undefined, tags: undefined, page: 2, limit: 50 })
      expect(next).toBeDefined()
    })

    it('omits nextCursor on the last page and maps tag → tags[]', async () => {
      state.mediaProvider!.listAssets.mockResolvedValue({ assets: [], total: 10 })
      const facet = (await loadFacet())!
      const result = await facet.list({ tag: 'hero', limit: 50 })
      expect(state.mediaProvider!.listAssets).toHaveBeenCalledWith('proj-1', { search: undefined, tags: ['hero'], page: 1, limit: 50 })
      expect(result.nextCursor).toBeUndefined()
    })

    it('clamps the limit to 1..100', async () => {
      state.mediaProvider!.listAssets.mockResolvedValue({ assets: [], total: 0 })
      const facet = (await loadFacet())!
      await facet.list({ limit: 5000 })
      expect(state.mediaProvider!.listAssets).toHaveBeenLastCalledWith('proj-1', expect.objectContaining({ limit: 100 }))
      await facet.list({})
      expect(state.mediaProvider!.listAssets).toHaveBeenLastCalledWith('proj-1', expect.objectContaining({ limit: 50 }))
    })

    it('rejects a malformed cursor with 400 media.invalid_cursor', async () => {
      const facet = (await loadFacet())!
      await expect(facet.list({ cursor: 'not-a-cursor' })).rejects.toMatchObject({ statusCode: 400, message: 'media.invalid_cursor' })
    })
  })

  describe('get / tenant isolation', () => {
    it('returns the asset for the session project', async () => {
      state.mediaProvider!.getAsset.mockResolvedValue(studioAsset())
      const facet = (await loadFacet())!
      expect(await facet.get('asset-1')).toMatchObject({ id: 'asset-1', mime: 'image/webp' })
    })

    it('returns null for a foreign-project asset (no leak)', async () => {
      state.mediaProvider!.getAsset.mockResolvedValue(studioAsset({ projectId: 'other-project' }))
      const facet = (await loadFacet())!
      expect(await facet.get('asset-1')).toBeNull()
    })

    it('returns null when the asset does not exist', async () => {
      state.mediaProvider!.getAsset.mockResolvedValue(null)
      const facet = (await loadFacet())!
      expect(await facet.get('nope')).toBeNull()
    })
  })

  describe('ingest', () => {
    it('runs the reserve → upload → reconcile dance and emits the webhook', async () => {
      state.mediaProvider!.upload.mockResolvedValue(studioAsset({ size: 1500 }))
      const facet = (await loadFacet())!

      const asset = await facet.ingest({ url: 'https://cdn.example/photo.png', alt: 'hi', tags: ['x'] })

      expect(state.fetchRemoteMedia).toHaveBeenCalledWith({ url: 'https://cdn.example/photo.png', maxBytes: 50 * 1024 * 1024 })
      // overage settings are read fresh, per call
      expect(state.getWorkspaceById).toHaveBeenCalledWith('ws-1', 'id, overage_settings')
      expect(state.reserveStorageIfAllowed).toHaveBeenCalledWith('ws-1', 2000, 15 * 1024 ** 3)
      expect(state.mediaProvider!.upload).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'proj-1', workspaceId: 'ws-1', uploadedBy: 'owner-1', source: 'agent', skipStorageIncrement: true,
      }))
      // reconcile 1500 actual − 2000 reserved = −500
      expect(state.incrementWorkspaceStorageBytes).toHaveBeenCalledWith('ws-1', -500)
      expect(state.emitWebhookEvent).toHaveBeenCalledWith('proj-1', 'ws-1', 'media.uploaded', expect.objectContaining({ assetId: 'asset-1' }))
      expect(asset).toMatchObject({ id: 'asset-1' })
    })

    it('honors a filename override', async () => {
      state.mediaProvider!.upload.mockResolvedValue(studioAsset())
      const facet = (await loadFacet())!
      await facet.ingest({ url: 'https://cdn.example/x.png', filename: 'renamed.png' })
      expect(state.mediaProvider!.upload).toHaveBeenCalledWith(expect.objectContaining({ filename: 'renamed.png' }))
    })

    it('403s when the storage reservation is refused, without uploading', async () => {
      state.reserveResult = { allowed: false, currentBytes: 999 }
      const facet = (await loadFacet())!
      await expect(facet.ingest({ url: 'https://cdn.example/x.png' })).rejects.toMatchObject({ statusCode: 403, message: 'storage.quota_exceeded' })
      expect(state.mediaProvider!.upload).not.toHaveBeenCalled()
    })

    it('releases the reservation when the upload throws', async () => {
      state.mediaProvider!.upload.mockRejectedValue(new Error('r2 down'))
      const facet = (await loadFacet())!
      await expect(facet.ingest({ url: 'https://cdn.example/x.png' })).rejects.toThrow('r2 down')
      expect(state.incrementWorkspaceStorageBytes).toHaveBeenCalledWith('ws-1', -2000)
    })

    it('swallows webhook failures (fire-and-forget)', async () => {
      state.mediaProvider!.upload.mockResolvedValue(studioAsset({ size: 2000 }))
      state.emitWebhookEvent.mockRejectedValue(new Error('webhook down'))
      const facet = (await loadFacet())!
      await expect(facet.ingest({ url: 'https://cdn.example/x.png' })).resolves.toMatchObject({ id: 'asset-1' })
    })

    it('skips reservation when the plan storage limit is 0 (unlimited-guard path)', async () => {
      state.planLimits['media.storage_gb'] = 0
      state.mediaProvider!.upload.mockResolvedValue(studioAsset())
      const facet = (await loadFacet())!
      await facet.ingest({ url: 'https://cdn.example/x.png' })
      expect(state.reserveStorageIfAllowed).not.toHaveBeenCalled()
      expect(state.mediaProvider!.upload).toHaveBeenCalledWith(expect.objectContaining({ skipStorageIncrement: false }))
    })
  })

  describe('update', () => {
    it('rejects a filename change (not a metadata-only op)', async () => {
      const facet = (await loadFacet())!
      await expect(facet.update('asset-1', { filename: 'new.png' })).rejects.toMatchObject({ statusCode: 400, message: 'media.rename_not_supported' })
    })

    it('404s a foreign/missing asset and passes only defined fields', async () => {
      state.mediaProvider!.getAsset.mockResolvedValue(studioAsset({ projectId: 'other' }))
      const facet = (await loadFacet())!
      await expect(facet.update('asset-1', { alt: 'x' })).rejects.toMatchObject({ statusCode: 404, message: 'media.asset_not_found' })

      state.mediaProvider!.getAsset.mockResolvedValue(studioAsset())
      state.mediaProvider!.updateMetadata.mockResolvedValue(studioAsset({ alt: 'updated' }))
      await facet.update('asset-1', { alt: 'updated' })
      expect(state.mediaProvider!.updateMetadata).toHaveBeenCalledWith('asset-1', { alt: 'updated' })
    })
  })

  describe('delete', () => {
    it('404s a foreign/missing asset', async () => {
      state.mediaProvider!.getAsset.mockResolvedValue(null)
      const facet = (await loadFacet())!
      await expect(facet.delete('asset-1')).rejects.toMatchObject({ statusCode: 404, message: 'media.asset_not_found' })
    })

    it('deletes with the session project scope', async () => {
      state.mediaProvider!.getAsset.mockResolvedValue(studioAsset())
      const facet = (await loadFacet())!
      await facet.delete('asset-1')
      expect(state.mediaProvider!.delete).toHaveBeenCalledWith('proj-1', 'asset-1')
    })
  })
})
