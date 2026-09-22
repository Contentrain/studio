import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'
import { STUDIO_TOOLS } from '../../server/utils/agent-tools'

/**
 * #289 — the agent holds a media path or delivery URL (from content, an
 * attachment, search_media) but get_media only took an asset id, and the
 * uuid inside a path is the storage key, not the asset id. It looked the
 * path up as an id, found nothing, and told the editor the image was gone.
 */

const PERMISSIONS: AgentPermissions = {
  workspaceRole: 'owner',
  projectRole: null,
  specificModels: false,
  allowedModels: [],
  allowedLocales: [],
  availableTools: ['get_media', 'search_media'],
}

const UI: ChatUIContext = { activeModelId: null, activeLocale: 'tr', activeEntryId: null, panelState: 'overview', activeBranch: null }

const ASSET = {
  id: 'a0000000-0000-0000-0000-000000000001',
  projectId: 'p1',
  filename: 'kapak.webp',
  originalPath: 'media/original/9f1c2d3e.webp',
  size: 48_213,
  createdAt: '2026-09-01T10:00:00.000Z',
  width: 1200,
  height: 630,
  format: 'webp',
  blurhash: null,
  alt: 'Kapak',
  tags: [],
  variants: {},
}

async function run(tool: string, params: Record<string, unknown>, media: Record<string, unknown>) {
  const { emptyAffected } = await import('../../server/utils/agent-types')
  const mediaUrl = await import('../../server/utils/media-url')
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.example' } }))
  vi.stubGlobal('emptyAffected', emptyAffected)
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
  vi.stubGlobal('agentMessage', vi.fn((key: string) => key))
  vi.stubGlobal('useMediaProvider', () => media)
  vi.stubGlobal('ownMediaStoragePath', mediaUrl.ownMediaStoragePath)
  vi.stubGlobal('toDeliveryUrl', mediaUrl.toDeliveryUrl)
  vi.stubGlobal('withMediaUrls', mediaUrl.withMediaUrls)
  const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
  return executeToolWithAutoMerge(
    tool, params, {} as never, {} as GitProvider, 'e@x.io', 'u1', 'media', 'auto-merge', PERMISSIONS, 'pro', 'p1', 'w1', UI,
  )
}

describe('media lookup by path or URL (#289)', () => {
  beforeAll(async () => {
    await import('../../server/utils/conversation-engine')
  }, 60_000)

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('lets get_media take an asset id, a path, or a URL', () => {
    const tool = STUDIO_TOOLS.find(t => t.name === 'get_media')!
    const schema = tool.inputSchema as { required?: string[], properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(['assetId', 'path', 'url'])
    expect(schema.required ?? []).toEqual([])
  })

  it('resolves a stored path to the asset', async () => {
    const media = { getAsset: vi.fn(), getAssetByPath: vi.fn().mockResolvedValue(ASSET) }
    const { result } = await run('get_media', { path: ASSET.originalPath }, media)
    expect(media.getAssetByPath).toHaveBeenCalledWith('p1', ASSET.originalPath)
    expect(media.getAsset).not.toHaveBeenCalled()
    expect(result).toMatchObject({ id: ASSET.id, url: `https://studio.example/api/cdn/v1/p1/${ASSET.originalPath}` })
  })

  it('resolves this project\'s delivery URL, query string and all', async () => {
    const media = { getAsset: vi.fn(), getAssetByPath: vi.fn().mockResolvedValue(ASSET) }
    await run('get_media', { url: `https://studio.example/api/cdn/v1/p1/${ASSET.originalPath}?w=400` }, media)
    expect(media.getAssetByPath).toHaveBeenCalledWith('p1', ASSET.originalPath)
  })

  it('does not look up another project\'s URL', async () => {
    const media = { getAsset: vi.fn(), getAssetByPath: vi.fn() }
    const { result } = await run('get_media', { url: `https://studio.example/api/cdn/v1/p2/${ASSET.originalPath}` }, media)
    expect(media.getAssetByPath).not.toHaveBeenCalled()
    expect(result).toEqual({ error: 'media.asset_not_found' })
  })

  it('still resolves by asset id, and asks for a reference when given none', async () => {
    const media = { getAsset: vi.fn().mockResolvedValue(ASSET), getAssetByPath: vi.fn() }
    expect((await run('get_media', { assetId: ASSET.id }, media)).result).toMatchObject({ id: ASSET.id })
    expect((await run('get_media', {}, media)).result).toEqual({ error: 'media.asset_reference_required' })
  })

  it('search_media reports each asset\'s path, size and upload date', async () => {
    const media = { listAssets: vi.fn().mockResolvedValue({ assets: [ASSET], total: 1 }) }
    const { result } = await run('search_media', { query: 'kapak' }, media)
    expect(result).toEqual([expect.objectContaining({ path: ASSET.originalPath, size: 48_213, createdAt: '2026-09-01T10:00:00.000Z' })])
  })
})
