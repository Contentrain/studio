import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'

/**
 * #289 — a chat image stays ephemeral until a write puts it into content.
 * Then the write promotes it into the media library: from the one-day
 * original, else from this turn's downscaled copy (said so), behind the
 * storage quota, scoped to the tenant it was attached in.
 */

const objects = new Map<string, { data: Buffer, contentType: string }>()
const cdn = {
  putObject: vi.fn(async (projectId: string, path: string, data: string | Buffer, contentType: string) => {
    objects.set(`${projectId}/${path}`, { data: Buffer.isBuffer(data) ? data : Buffer.from(data), contentType })
    return { path, size: 0, contentType, etag: 'e' }
  }),
  getObject: vi.fn(async (projectId: string, path: string) => objects.get(`${projectId}/${path}`) ?? null),
  deleteObject: vi.fn(async (projectId: string, path: string) => {
    objects.delete(`${projectId}/${path}`)
  }),
}
/** The media library: asset id → path. */
const library = new Map<string, string>()
const upload = vi.fn()
const remove = vi.fn(async (_projectId: string, assetId: string) => {
  library.delete(assetId)
})
const reserve = vi.fn()
const increment = vi.fn()
let mediaAvailable = true

vi.mock('../../server/utils/providers', () => ({
  useCDNProvider: () => cdn,
  useMediaProvider: () => (mediaAvailable ? { upload, delete: remove } : null),
  useDatabaseProvider: () => ({ reserveStorageIfAllowed: reserve, incrementWorkspaceStorageBytes: increment }),
}))

const { isStashExpired, newStashId, stashOriginal } = await import('../../server/utils/attachment-stash')
const { promoteAttachmentMarkers } = await import('../../server/utils/attachment-promotion')
const { ingestFile, validateAttachmentBlocks } = await import('../../server/utils/attachment-ingest')

const SCOPE = { workspaceId: 'ws1', projectId: 'p1' }
const ORIGINAL = Buffer.from('original-bytes')

function context(overrides: Partial<Parameters<typeof promoteAttachmentMarkers>[1]> = {}) {
  return {
    ...SCOPE,
    userId: 'u1',
    plan: 'pro',
    cdnEnabled: true,
    storageLimitBytes: 1_000_000,
    downscaled: new Map(),
    ...overrides,
  }
}

beforeEach(() => {
  objects.clear()
  mediaAvailable = true
  library.clear()
  remove.mockClear()
  cdn.putObject.mockClear()
  upload.mockReset().mockImplementation(async ({ filename }: { filename: string }) => {
    const id = `asset-${library.size + 1}`
    library.set(id, `media/original/${filename}.webp`)
    return { id, originalPath: `media/original/${filename}.webp`, size: 10 }
  })
  reserve.mockReset().mockResolvedValue({ allowed: true, currentBytes: 0 })
  increment.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('hasFeature', vi.fn(() => true))
  vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.example' } }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('attachment stash', () => {
  it('keys originals under the bucket-level _tmp prefix, per workspace and project', async () => {
    const id = await stashOriginal(cdn as never, SCOPE, { buffer: ORIGINAL, contentType: 'image/png', filename: 'kapak.png' })
    expect(objects.has(`_tmp/ws1/p1/${id}`)).toBe(true)
  })

  it('treats an id older than a day, or a malformed one, as expired', () => {
    const now = Date.now()
    expect(isStashExpired(newStashId(now), now)).toBe(false)
    expect(isStashExpired(newStashId(now - 25 * 3600_000), now)).toBe(true)
    expect(isStashExpired('../../p2/x', now)).toBe(true)
  })
})

describe('promoteAttachmentMarkers', () => {
  it('promotes the original and replaces the marker in fields and markdown, without mutating the input', async () => {
    const id = await stashOriginal(cdn as never, SCOPE, { buffer: ORIGINAL, contentType: 'image/png', filename: 'kapak.png' })
    const input = { data: { a1: { cover: `attachment:${id}`, body: `Giriş\n\n![kapak](attachment:${id})` } } }
    const frozen = JSON.stringify(input)

    const result = await promoteAttachmentMarkers(input, context())

    expect('error' in result).toBe(false)
    const { value, promoted } = result as Exclude<typeof result, { error: string }>
    const url = 'https://studio.example/api/cdn/v1/p1/media/original/kapak.png.webp'
    expect(value.data.a1).toEqual({ cover: url, body: `Giriş\n\n![kapak](${url})` })
    expect(promoted).toEqual([{ attachment: id, path: 'media/original/kapak.png.webp', url }])
    expect(upload).toHaveBeenCalledOnce()
    expect(upload.mock.calls[0]![0]).toMatchObject({ file: ORIGINAL, contentType: 'image/png', skipStorageIncrement: true })
    expect(JSON.stringify(input)).toBe(frozen)
  })

  it('reuses the asset when the same attachment is written again', async () => {
    const id = await stashOriginal(cdn as never, SCOPE, { buffer: ORIGINAL, contentType: 'image/png', filename: 'kapak.png' })
    await promoteAttachmentMarkers({ cover: `attachment:${id}` }, context())
    await promoteAttachmentMarkers({ cover: `attachment:${id}` }, context())
    expect(upload).toHaveBeenCalledOnce()
  })

  it('falls back to this turn\'s downscaled copy when the original has expired, and says so', async () => {
    const id = newStashId()
    const downscaled = new Map([[id, { buffer: Buffer.from('small'), contentType: 'image/webp', filename: 'kapak.png' }]])

    const result = await promoteAttachmentMarkers({ cover: `attachment:${id}` }, context({ downscaled }))

    expect((result as { promoted: unknown[] }).promoted).toEqual([expect.objectContaining({ attachment: id, downscaled: true })])
    expect(upload.mock.calls[0]![0]).toMatchObject({ contentType: 'image/webp' })
  })

  it('refuses the write when neither the original nor a copy is left', async () => {
    const result = await promoteAttachmentMarkers({ cover: `attachment:${newStashId()}` }, context())
    expect(result).toEqual({ error: 'attachment.promotion_expired' })
  })

  it('refuses the write, uploading nothing, when storage is full', async () => {
    const id = await stashOriginal(cdn as never, SCOPE, { buffer: ORIGINAL, contentType: 'image/png', filename: 'kapak.png' })
    reserve.mockResolvedValue({ allowed: false, currentBytes: 1_000_000 })

    const result = await promoteAttachmentMarkers({ cover: `attachment:${id}` }, context())

    expect(result).toEqual({ error: 'attachment.promotion_quota_exceeded' })
    expect(upload).not.toHaveBeenCalled()
  })

  it('leaves no asset behind when a later attachment of the same save hits the quota', async () => {
    const first = await stashOriginal(cdn as never, SCOPE, { buffer: ORIGINAL, contentType: 'image/png', filename: 'bir.png' })
    const second = await stashOriginal(cdn as never, SCOPE, { buffer: ORIGINAL, contentType: 'image/png', filename: 'iki.png' })
    reserve.mockResolvedValueOnce({ allowed: true, currentBytes: 0 }).mockResolvedValueOnce({ allowed: false, currentBytes: 1_000_000 })

    const result = await promoteAttachmentMarkers({ a: `attachment:${first}`, b: `attachment:${second}` }, context())

    expect(result).toEqual({ error: 'attachment.promotion_quota_exceeded' })
    expect(upload).toHaveBeenCalledOnce()
    expect(library.size).toBe(0)
    expect([...objects.keys()].some(k => k.endsWith('.promoted.json'))).toBe(false)
  })

  it('rolls the upload back when its promotion cannot be recorded', async () => {
    const id = await stashOriginal(cdn as never, SCOPE, { buffer: ORIGINAL, contentType: 'image/png', filename: 'kapak.png' })
    const put = cdn.putObject.getMockImplementation()!
    cdn.putObject.mockImplementation(async (projectId, path, data, contentType) => {
      if (path.endsWith('.promoted.json')) throw new Error('R2 unavailable')
      return put(projectId, path, data, contentType)
    })

    const result = await promoteAttachmentMarkers({ cover: `attachment:${id}` }, context())
    cdn.putObject.mockImplementation(put)

    expect(result).toEqual({ error: 'attachment.media_upload_failed' })
    expect(remove).toHaveBeenCalledWith('p1', 'asset-1')
    expect(library.size).toBe(0)
    expect(cdn.deleteObject).toHaveBeenCalledWith('_tmp', expect.stringMatching(/\.promoted\.json$/))
  })

  it('does not resolve an attachment made in another workspace', async () => {
    const id = await stashOriginal(cdn as never, { workspaceId: 'ws2', projectId: 'p9' }, { buffer: ORIGINAL, contentType: 'image/png', filename: 'x.png' })

    const result = await promoteAttachmentMarkers({ cover: `attachment:${id}` }, context())

    expect(result).toEqual({ error: 'attachment.promotion_expired' })
    expect(upload).not.toHaveBeenCalled()
  })
})

describe('chat attachment → marker', () => {
  it('stashes a context image\'s original and tells the agent the marker to write', async () => {
    const sharp = (await import('sharp')).default
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer()

    const ref = await ingestFile({ buffer: png, filename: 'kapak.png', declaredMime: 'image/png', ...SCOPE, userId: 'u1', plan: 'pro', intent: 'context', cdnEnabled: true })

    expect(ref.destination).toBe('context')
    expect(ref.stashId).toMatch(/^[0-9a-z]+\.[0-9a-f]{32}$/)
    expect(objects.get(`_tmp/ws1/p1/${ref.stashId}`)?.data.equals(png)).toBe(true)

    vi.stubGlobal('createError', (e: { message: string }) => new Error(e.message))
    const validated = validateAttachmentBlocks([{ filename: 'kapak.png', blocks: ref.blocks, stashId: ref.stashId }], { projectId: 'p1' })
    expect((validated.blocks[0] as { text: string }).text).toContain(`attachment:${ref.stashId}`)
    expect(validated.downscaled.has(ref.stashId!)).toBe(true)
  })

  it('stashes nothing where the project cannot store media', async () => {
    mediaAvailable = false
    const sharp = (await import('sharp')).default
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer()
    const ref = await ingestFile({ buffer: png, filename: 'kapak.png', declaredMime: 'image/png', ...SCOPE, userId: 'u1', plan: 'pro', intent: 'context', cdnEnabled: true })
    expect(ref.stashId).toBeUndefined()
    expect(objects.size).toBe(0)
  })
})

describe('save_content with an attachment marker', () => {
  beforeAll(async () => {
    await import('../../server/utils/conversation-engine')
  }, 60_000)

  const PERMISSIONS: AgentPermissions = { workspaceRole: 'owner', projectRole: null, specificModels: false, allowedModels: [], allowedLocales: [], availableTools: ['save_content'] }
  const UI: ChatUIContext = { activeModelId: null, activeLocale: 'tr', activeEntryId: null, panelState: 'overview', activeBranch: null }

  it('writes the promoted URL, lists the asset, and leaves the tool input untouched', async () => {
    const id = await stashOriginal(cdn as never, SCOPE, { buffer: ORIGINAL, contentType: 'image/png', filename: 'kapak.png' })
    const { emptyAffected } = await import('../../server/utils/agent-types')
    vi.stubGlobal('emptyAffected', emptyAffected)
    vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { locales: { default: 'tr' } }, content: new Map(), meta: new Map(), models: new Map() }))
    const engine = {
      saveContent: vi.fn().mockResolvedValue({ branch: 'cr/x', commit: { sha: 'c1' }, diff: [], validation: { valid: true, errors: [] }, entries: { created: [], updated: ['a1'] } }),
      mergeBranch: vi.fn().mockResolvedValue({ merged: true }),
    }
    const input = { model: 'articles', mode: 'update', data: { a1: { cover: `attachment:${id}` } } }
    const frozen = JSON.stringify(input)

    const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
    const { result } = await executeToolWithAutoMerge('save_content', input, engine as never, {} as GitProvider, 'e@x.io', 'u1', 'content', 'auto-merge', PERMISSIONS, 'pro', 'p1', 'ws1', UI, undefined, context())

    expect(engine.saveContent.mock.calls[0]![2]).toEqual({ a1: { cover: 'https://studio.example/api/cdn/v1/p1/media/original/kapak.png.webp' } })
    expect(result).toMatchObject({ promotedAttachments: [{ attachment: id, path: 'media/original/kapak.png.webp' }] })
    expect(JSON.stringify(input)).toBe(frozen)
  })
})
