import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestMediaUrls } from '../../server/utils/media-bulk-ingest'

function makeAsset(id: string, size: number) {
  return {
    id,
    projectId: 'p-1',
    filename: `${id}.jpg`,
    contentType: 'image/jpeg',
    size,
    width: 10,
    height: 10,
    format: 'jpeg',
    blurhash: null,
    alt: null,
    focalPoint: null,
    variants: { thumb: { path: `media/thumb/${id}.webp`, width: 5, height: 5, format: 'webp', size: 1 } },
    tags: [],
    uploadedBy: 'u-1',
    source: 'url' as const,
    originalPath: `media/original/${id}.jpg`,
    contentHash: id,
    usedIn: [],
    createdAt: '',
    updatedAt: '',
  }
}

describe('ingestMediaUrls', () => {
  const db = {
    getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws-1', overage_settings: null }),
    reserveStorageIfAllowed: vi.fn().mockResolvedValue({ allowed: true, currentBytes: 0 }),
    incrementWorkspaceStorageBytes: vi.fn().mockResolvedValue(undefined),
  }
  const emitWebhookEvent = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.stubGlobal('useDatabaseProvider', () => db)
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.test' } }))
    vi.stubGlobal('getPlanLimit', (_: string, key: string) => key === 'media.max_file_size_mb' ? 10 : key === 'media.storage_gb' ? 1 : 5)
    vi.stubGlobal('hasFeature', () => false)
    vi.stubGlobal('emitWebhookEvent', emitWebhookEvent)
    vi.stubGlobal('errorMessage', (key: string) => key)
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), { statusCode: input.statusCode }))
    vi.stubGlobal('useMediaProvider', () => null)
    db.reserveStorageIfAllowed.mockClear()
    db.incrementWorkspaceStorageBytes.mockClear()
    emitWebhookEvent.mockClear()
  })

  it('collapses duplicate URLs, keeps order, maps old → new, and reports per-item failures without aborting', async () => {
    const fetchMedia = vi.fn(async ({ url }: { url: string }) => {
      if (url.includes('missing')) throw Object.assign(new Error('media.url_bad_response'), { statusCode: 400 })
      return { buffer: Buffer.alloc(100), filename: url.split('/').pop()!, contentType: 'image/jpeg' }
    })
    let n = 0
    const media = { upload: vi.fn(async () => makeAsset(`a${++n}`, 80)) }

    const report = await ingestMediaUrls({
      projectId: 'p-1',
      workspaceId: 'ws-1',
      plan: 'pro',
      uploadedBy: 'u-1',
      items: [
        { url: 'https://old.example/a.jpg', alt: 'A' },
        { url: 'https://old.example/missing.jpg' },
        { url: 'https://old.example/a.jpg' },
        { url: 'not a url' },
        { url: 'https://old.example/b.jpg' },
      ],
      fetchMedia,
      media: media as never,
    })

    expect(report.requested).toBe(5)
    expect(report.unique).toBe(3)
    expect(report.succeeded).toBe(2)
    expect(report.failed).toBe(2)
    expect(fetchMedia).toHaveBeenCalledTimes(3)
    expect(report.map).toEqual({
      'https://old.example/a.jpg': 'https://studio.test/api/cdn/v1/p-1/media/original/a1.jpg',
      'https://old.example/b.jpg': 'https://studio.test/api/cdn/v1/p-1/media/original/a2.jpg',
    })
    const failed = report.results.filter(r => !r.ok)
    expect(failed.map(r => r.url)).toEqual(['not a url', 'https://old.example/missing.jpg'])
    expect(failed[1]!.error).toBe('media.url_bad_response')
    expect(report.results.find(r => r.url === 'https://old.example/a.jpg')?.variantUrls).toEqual({ thumb: 'https://studio.test/api/cdn/v1/p-1/media/thumb/a1.webp' })
    // Reservation reconciled to the optimised size (100 fetched → 80 stored).
    expect(db.incrementWorkspaceStorageBytes).toHaveBeenCalledWith('ws-1', -20)
    expect(emitWebhookEvent).toHaveBeenCalledTimes(2)
    expect(media.upload).toHaveBeenCalledWith(expect.objectContaining({ alt: 'A', source: 'url', skipStorageIncrement: true }))
  })

  it('releases the reservation when the upload fails and reports quota refusals', async () => {
    const fetchMedia = vi.fn(async ({ url }: { url: string }) => ({ buffer: Buffer.alloc(50), filename: url.split('/').pop()!, contentType: 'image/png' }))
    db.reserveStorageIfAllowed.mockResolvedValueOnce({ allowed: true, currentBytes: 0 }).mockResolvedValueOnce({ allowed: false, currentBytes: 999 })
    const media = { upload: vi.fn().mockRejectedValueOnce(new Error('sharp exploded')) }

    const report = await ingestMediaUrls({
      projectId: 'p-1',
      workspaceId: 'ws-1',
      plan: 'pro',
      uploadedBy: 'u-1',
      items: [{ url: 'https://old.example/x.png' }, { url: 'https://old.example/y.png' }],
      concurrency: 1,
      fetchMedia,
      media: media as never,
    })

    expect(report.succeeded).toBe(0)
    expect(report.results[0]).toMatchObject({ ok: false, error: 'sharp exploded' })
    expect(report.results[1]).toMatchObject({ ok: false, error: 'storage.quota_exceeded', statusCode: 403 })
    expect(db.incrementWorkspaceStorageBytes).toHaveBeenCalledWith('ws-1', -50)
    expect(media.upload).toHaveBeenCalledTimes(1)
  })

  it('refuses when no media stack is configured', async () => {
    await expect(ingestMediaUrls({ projectId: 'p-1', workspaceId: 'ws-1', plan: 'pro', uploadedBy: 'u-1', items: [{ url: 'https://x/y.jpg' }] }))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('reuses the asset a project already holds for the same bytes', async () => {
    // The cross-request half of idempotency. A retried batch must not buy the
    // same bytes twice, and the map it gets back has to keep pointing at the
    // asset the project's content already references.
    const existing = makeAsset('already-here', 80)
    const upload = vi.fn(async () => makeAsset('new-one', 80))
    const getAssetByContentHash = vi.fn(async () => existing)
    const media = { upload, getAssetByContentHash }

    const report = await ingestMediaUrls({
      projectId: 'p-1',
      workspaceId: 'ws-1',
      plan: 'pro',
      uploadedBy: 'u-1',
      items: [{ url: 'https://old.example/a.jpg' }],
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.alloc(100), filename: 'a.jpg', contentType: 'image/jpeg' })),
      media: media as never,
    })

    expect(report.succeeded).toBe(1)
    expect(report.deduped).toBe(1)
    expect(report.results[0]).toMatchObject({ ok: true, assetId: 'already-here', deduped: true })
    expect(report.map['https://old.example/a.jpg']).toContain('media/original/already-here.jpg')
    expect(upload).not.toHaveBeenCalled()
    // Neither quota nor storage moves for bytes the project already paid for.
    expect(db.reserveStorageIfAllowed).not.toHaveBeenCalled()
    expect(db.incrementWorkspaceStorageBytes).not.toHaveBeenCalled()
  })

  it('asks with the hash of the bytes as fetched, not of anything optimised', async () => {
    // The provider hashes the original on the way in, before it touches the
    // file. Hashing anything else here would make the two disagree about
    // identity and the dedupe would silently never fire.
    const buffer = Buffer.from('the exact bytes')
    const expected = createHash('sha256').update(buffer).digest('hex')
    const getAssetByContentHash = vi.fn(async () => null)

    await ingestMediaUrls({
      projectId: 'p-1',
      workspaceId: 'ws-1',
      plan: 'pro',
      uploadedBy: 'u-1',
      items: [{ url: 'https://old.example/a.jpg' }],
      fetchMedia: vi.fn(async () => ({ buffer, filename: 'a.jpg', contentType: 'image/jpeg' })),
      media: { upload: vi.fn(async () => makeAsset('a1', 80)), getAssetByContentHash } as never,
    })

    expect(getAssetByContentHash).toHaveBeenCalledWith('p-1', expected)
  })

  it('uploads anyway when the caller opts out, or the provider cannot be asked', async () => {
    const fetchMedia = vi.fn(async () => ({ buffer: Buffer.alloc(100), filename: 'a.jpg', contentType: 'image/jpeg' }))
    const getAssetByContentHash = vi.fn(async () => makeAsset('already-here', 80))

    const optedOut = await ingestMediaUrls({
      projectId: 'p-1',
      workspaceId: 'ws-1',
      plan: 'pro',
      uploadedBy: 'u-1',
      items: [{ url: 'https://old.example/a.jpg' }],
      fetchMedia,
      dedupe: false,
      media: { upload: vi.fn(async () => makeAsset('new-one', 80)), getAssetByContentHash } as never,
    })
    expect(optedOut.deduped).toBe(0)
    expect(optedOut.results[0]?.assetId).toBe('new-one')
    expect(getAssetByContentHash).not.toHaveBeenCalled()

    // A provider double without the optional method degrades to the old
    // behaviour rather than throwing.
    const noCapability = await ingestMediaUrls({
      projectId: 'p-1',
      workspaceId: 'ws-1',
      plan: 'pro',
      uploadedBy: 'u-1',
      items: [{ url: 'https://old.example/a.jpg' }],
      fetchMedia,
      media: { upload: vi.fn(async () => makeAsset('new-two', 80)) } as never,
    })
    expect(noCapability.deduped).toBe(0)
    expect(noCapability.results[0]?.assetId).toBe('new-two')
  })

  it('still creates a new asset when a URL now serves different bytes', async () => {
    // Keying on the URL would have refused to. Keying on the bytes gets both
    // properties: a retry is free, a changed image is a new asset.
    const getAssetByContentHash = vi.fn(async () => null)
    const report = await ingestMediaUrls({
      projectId: 'p-1',
      workspaceId: 'ws-1',
      plan: 'pro',
      uploadedBy: 'u-1',
      items: [{ url: 'https://old.example/a.jpg' }],
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('different now'), filename: 'a.jpg', contentType: 'image/jpeg' })),
      media: { upload: vi.fn(async () => makeAsset('a-second', 80)), getAssetByContentHash } as never,
    })
    expect(report.deduped).toBe(0)
    expect(report.results[0]?.assetId).toBe('a-second')
  })
})
