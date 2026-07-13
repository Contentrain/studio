/**
 * MCP media facet — the `RepoProvider.media` implementation for MCP Cloud
 * loopback providers.
 *
 * @contentrain/mcp 1.10.0's five media tools (list/get/ingest/update/delete)
 * are gated by a `media` facet on the provider object; absent facet =
 * tools hidden from tools/list. This builder produces the contract
 * `MediaProvider` (from @contentrain/types) as a deterministic passthrough
 * over Studio's own media stack — MCP makes no content decisions, the
 * facet owns SSRF/MIME/size/quota/tenant policy.
 *
 * Eligibility (media stack present, plan, cdn_enabled, owner) is decided by
 * the proxy, which injects the identity headers the loopback turns into
 * this builder's input. `buildMcpMediaFacet` still returns null when
 * `useMediaProvider()` is null (defense in depth for CE / no-R2), so the
 * facet is simply absent and the tools stay hidden.
 *
 * `uploadedBy` is the workspace owner id — MCP sessions have no acting
 * user, matching the public media API's keyless-upload attribution
 * (server/utils/media-api.ts). Ingested assets carry `source: 'agent'`.
 */
import { Buffer } from 'node:buffer'
import type {
  MediaAsset as ContractMediaAsset,
  MediaListOptions as ContractMediaListOptions,
  MediaListResult as ContractMediaListResult,
  MediaProvider as ContractMediaProvider,
} from '@contentrain/types'
import type { MediaAsset as StudioMediaAsset } from '../providers/media'
import type { Plan } from './license'
import { fetchRemoteMedia } from './media-ingest'
import { withMediaUrls } from './media-url'
import { resolveVariantConfigWithPlan } from './media-variants'

export interface McpMediaFacetInput {
  projectId: string
  workspaceId: string
  /** workspace owner_id — `uploaded_by` for keyless surfaces. */
  uploadedBy: string
  /** plan slug captured at session creation — used for size/variant/storage limits. */
  plan: Plan
}

interface CursorState {
  /** 1-based page. */
  p: number
  /** page size the cursor was minted with. */
  l: number
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf-8').toString('base64url')
}

function decodeCursor(raw: string): CursorState | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as unknown
    if (
      typeof parsed === 'object' && parsed !== null
      && Number.isInteger((parsed as CursorState).p) && (parsed as CursorState).p >= 1
      && Number.isInteger((parsed as CursorState).l) && (parsed as CursorState).l >= 1
    ) {
      return parsed as CursorState
    }
  }
  catch {
    // fall through
  }
  return null
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) return 50
  return Math.min(Math.max(Math.trunc(limit), 1), 100)
}

/**
 * Map Studio's rich MediaAsset to the minimal contract shape. Studio
 * extras (dimensions/blurhash/variants/focal point) ride in `meta`.
 */
function toContractAsset(projectId: string, asset: StudioMediaAsset): ContractMediaAsset {
  const decorated = withMediaUrls(projectId, asset)
  return {
    id: asset.id,
    path: asset.originalPath,
    url: decorated.url,
    mime: asset.contentType,
    size: asset.size,
    alt: asset.alt ?? undefined,
    tags: asset.tags,
    createdAt: asset.createdAt,
    meta: {
      filename: asset.filename,
      width: asset.width,
      height: asset.height,
      format: asset.format,
      blurhash: asset.blurhash,
      focalPoint: asset.focalPoint,
      variants: asset.variants,
      variantUrls: decorated.variantUrls,
      source: asset.source,
      updatedAt: asset.updatedAt,
    },
  }
}

/**
 * Build the contract media facet for one MCP Cloud session, or null when
 * the media stack is unavailable (Community Edition / unconfigured R2).
 */
export function buildMcpMediaFacet(input: McpMediaFacetInput): ContractMediaProvider | null {
  const media = useMediaProvider()
  if (!media) return null

  return {
    async list(opts?: ContractMediaListOptions): Promise<ContractMediaListResult> {
      let page = 1
      let limit = clampLimit(opts?.limit)
      if (opts?.cursor) {
        const decoded = decodeCursor(opts.cursor)
        if (!decoded)
          throw createError({ statusCode: 400, message: errorMessage('media.invalid_cursor') })
        page = decoded.p
        limit = decoded.l
      }

      const result = await media.listAssets(input.projectId, {
        search: opts?.search,
        tags: opts?.tag ? [opts.tag] : undefined,
        page,
        limit,
      })

      return {
        assets: result.assets.map(asset => toContractAsset(input.projectId, asset)),
        total: result.total,
        nextCursor: page * limit < result.total ? encodeCursor({ p: page + 1, l: limit }) : undefined,
      }
    },

    async get(id: string): Promise<ContractMediaAsset | null> {
      const asset = await media.getAsset(id)
      // Tenant isolation: getAsset is global by id, so a cross-project
      // probe (guessing a UUID) must read as "not found", not leak.
      if (!asset || asset.projectId !== input.projectId) return null
      return toContractAsset(input.projectId, asset)
    },

    async ingest(req): Promise<ContractMediaAsset> {
      const maxBytes = getPlanLimit(input.plan, 'media.max_file_size_mb') * 1024 * 1024
      // SSRF + MIME + size policy is owned here — MCP never fetches.
      const remote = await fetchRemoteMedia({ url: req.url, maxBytes })
      const filename = req.filename?.trim() || remote.filename

      const variants = resolveVariantConfigWithPlan(undefined, {
        hasCustomVariants: hasFeature(input.plan, 'media.custom_variants'),
        variantsPerFieldLimit: getPlanLimit(input.plan, 'media.variants_per_field'),
      })

      // Overage settings are the operator's kill switch — read them per
      // call rather than trusting the (up to 15-min-old) session snapshot.
      const db = useDatabaseProvider()
      const workspace = await db.getWorkspaceById(input.workspaceId, 'id, overage_settings')
      const overageSettings = (workspace?.overage_settings as Record<string, boolean> | null) ?? {}
      const baseLimit = getPlanLimit(input.plan, 'media.storage_gb') * 1024 * 1024 * 1024
      const storageLimit = getEffectiveLimit(baseLimit, 'media.storage_gb', overageSettings)

      let storageReserved = false
      if (storageLimit > 0) {
        const reservation = await db.reserveStorageIfAllowed(input.workspaceId, remote.buffer.length, storageLimit)
        if (!reservation.allowed)
          throw createError({ statusCode: 403, message: errorMessage('storage.quota_exceeded') })
        storageReserved = true
      }

      try {
        const asset = await media.upload({
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          file: remote.buffer,
          filename,
          contentType: remote.contentType,
          alt: req.alt,
          tags: req.tags,
          variants,
          uploadedBy: input.uploadedBy,
          source: 'agent',
          skipStorageIncrement: storageReserved,
        })

        // Reconcile the reservation to the post-optimization size.
        if (storageReserved) {
          const actualBytes = typeof asset.size === 'number' ? asset.size : 0
          const delta = actualBytes - remote.buffer.length
          if (delta !== 0)
            await db.incrementWorkspaceStorageBytes(input.workspaceId, delta)
        }

        emitWebhookEvent(input.projectId, input.workspaceId, 'media.uploaded', {
          assetId: asset.id,
          filename: asset.filename,
          contentType: asset.contentType,
        }).catch(() => {})

        return toContractAsset(input.projectId, asset)
      }
      catch (err) {
        if (storageReserved)
          await db.incrementWorkspaceStorageBytes(input.workspaceId, -remote.buffer.length).catch(() => {})
        throw err
      }
    },

    async update(id: string, patch): Promise<ContractMediaAsset> {
      // Studio derives R2 object keys from the filename, so renames aren't
      // a metadata-only op — reject rather than silently ignore.
      if (patch.filename !== undefined)
        throw createError({ statusCode: 400, message: errorMessage('media.rename_not_supported') })

      const existing = await media.getAsset(id)
      if (!existing || existing.projectId !== input.projectId)
        throw createError({ statusCode: 404, message: errorMessage('media.asset_not_found') })

      const metadata: { alt?: string, tags?: string[] } = {}
      if (patch.alt !== undefined) metadata.alt = patch.alt
      if (patch.tags !== undefined) metadata.tags = patch.tags

      const updated = await media.updateMetadata(id, metadata)
      return toContractAsset(input.projectId, updated)
    },

    async delete(id: string): Promise<void> {
      const existing = await media.getAsset(id)
      if (!existing || existing.projectId !== input.projectId)
        throw createError({ statusCode: 404, message: errorMessage('media.asset_not_found') })
      // R2 original + variants + DB row + storage decrement. MCP enforces
      // confirm:true via zod before we get here.
      await media.delete(input.projectId, id)
    },
  }
}
