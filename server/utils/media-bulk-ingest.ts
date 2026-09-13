/**
 * Bulk media ingest — N remote URLs → Studio media assets → a URL map
 * (source URL → delivery URL) the caller rewrites its content with.
 *
 * This is the S-06 primitive for a migration: every image a WordPress site
 * still serves from its old host is fetched (SSRF-guarded, MIME- and
 * size-checked by `fetchRemoteMedia`), stored through the media provider
 * (quota reserved atomically, reconciled to the optimised size), and
 * reported with its new delivery URL. One failing URL never fails the batch;
 * it is reported per item so the caller can retry exactly what is missing.
 *
 * Idempotent in both directions. Within a request, duplicate URLs collapse to
 * one fetch. Across requests, a fetched file whose bytes the project already
 * holds resolves to the existing asset instead of a second one — keyed on the
 * content hash rather than the URL, which is the difference between two useful
 * properties and one misleading one:
 *
 * - a retried batch does not double the project's storage, and the URL map it
 *   gets back still points at the asset its content already references;
 * - a source site serving one image under two paths (WordPress does this
 *   constantly) lands one asset, not two;
 * - and a URL whose content has actually changed still produces a new asset,
 *   which keying on the URL would have quietly refused to do.
 *
 * The fetch still happens — the bytes are what is being identified — so this
 * saves storage, quota and library clutter, not bandwidth.
 */

import { createHash } from 'node:crypto'
import type { MediaProvider } from '~~/server/providers/media'
import type { Plan } from './license'
import type { RemoteMedia } from './media-ingest'
import { fetchRemoteMedia } from './media-ingest'
import { getEffectiveLimit } from './overage'
import { resolveVariantConfigWithPlan } from './media-variants'
import { toDeliveryUrl } from './media-url'

export const BULK_INGEST_MAX_ITEMS = 100
export const BULK_INGEST_MAX_CONCURRENCY = 5

export interface BulkIngestItem {
  url: string
  alt?: string
  tags?: string[]
  filename?: string
}

export interface BulkIngestItemResult {
  url: string
  ok: boolean
  assetId?: string
  /** Storage path (`media/original/…`) — the value content fields store. */
  path?: string
  /** Absolute delivery URL for the original. */
  deliveryUrl?: string
  /** Delivery URLs per generated variant. */
  variantUrls?: Record<string, string>
  error?: string
  statusCode?: number
  /** True when the project already held these bytes and no new asset was created. */
  deduped?: boolean
}

export interface BulkIngestReport {
  requested: number
  unique: number
  succeeded: number
  failed: number
  /** Of the successes, how many resolved to an asset the project already had. */
  deduped: number
  results: BulkIngestItemResult[]
  /** source URL → delivery URL, successful items only. */
  map: Record<string, string>
}

export interface BulkIngestInput {
  projectId: string
  workspaceId: string
  plan: Plan
  uploadedBy: string
  items: BulkIngestItem[]
  concurrency?: number
  source?: 'url' | 'agent'
  /** Test seam — defaults to the SSRF/MIME/size-hardened fetch. */
  fetchMedia?: (input: { url: string, maxBytes: number }) => Promise<RemoteMedia>
  /**
   * Reuse an asset the project already holds for the same bytes. On by
   * default: an ingest is machine-driven and a retry must not cost twice.
   * A caller that genuinely wants a second copy passes false.
   */
  dedupe?: boolean
  media?: MediaProvider
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  }
  catch {
    return null
  }
}

function errorDetails(error: unknown): { message: string, statusCode?: number } {
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown, statusMessage?: unknown, statusCode?: unknown }
    const message = typeof e.message === 'string' && e.message ? e.message : (typeof e.statusMessage === 'string' ? e.statusMessage : 'failed')
    return { message, statusCode: typeof e.statusCode === 'number' ? e.statusCode : undefined }
  }
  return { message: 'failed' }
}

export async function ingestMediaUrls(input: BulkIngestInput): Promise<BulkIngestReport> {
  const resolved = input.media ?? useMediaProvider()
  if (!resolved)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })
  const media: MediaProvider = resolved

  const fetchMedia = input.fetchMedia ?? fetchRemoteMedia
  const db = useDatabaseProvider()
  const maxBytes = getPlanLimit(input.plan, 'media.max_file_size_mb') * 1024 * 1024
  const variants = resolveVariantConfigWithPlan(undefined, {
    hasCustomVariants: hasFeature(input.plan, 'media.custom_variants'),
    variantsPerFieldLimit: getPlanLimit(input.plan, 'media.variants_per_field'),
  })

  const workspace = await db.getWorkspaceById(input.workspaceId, 'id, overage_settings')
  const overageSettings = (workspace?.overage_settings as Record<string, boolean> | null) ?? {}
  const baseLimit = getPlanLimit(input.plan, 'media.storage_gb') * 1024 * 1024 * 1024
  const storageLimit = getEffectiveLimit(baseLimit, 'media.storage_gb', overageSettings)

  // Collapse duplicates, keep first occurrence's alt/tags; invalid URLs are reported, not thrown.
  const results: BulkIngestItemResult[] = []
  const queue: Array<BulkIngestItem & { url: string }> = []
  const seen = new Set<string>()
  for (const item of input.items) {
    const url = normalizeUrl(String(item.url ?? ''))
    if (!url) {
      results.push({ url: String(item.url ?? ''), ok: false, error: errorMessage('media.url_blocked'), statusCode: 400 })
      continue
    }
    if (seen.has(url)) continue
    seen.add(url)
    queue.push({ ...item, url })
  }

  const dedupe = input.dedupe !== false && typeof media.getAssetByContentHash === 'function'

  /** What a caller gets back for an asset, whether it was just made or already there. */
  function describe(url: string, asset: { id: string, originalPath: string, variants?: Record<string, { path: string }> }, deduped: boolean): BulkIngestItemResult {
    return {
      url,
      ok: true,
      assetId: asset.id,
      path: asset.originalPath,
      deliveryUrl: toDeliveryUrl(input.projectId, asset.originalPath),
      variantUrls: Object.fromEntries(Object.entries(asset.variants ?? {}).map(([key, v]) => [key, toDeliveryUrl(input.projectId, v.path)])),
      ...(deduped ? { deduped: true } : {}),
    }
  }

  async function ingestOne(item: BulkIngestItem & { url: string }): Promise<BulkIngestItemResult> {
    let remote: RemoteMedia
    try {
      remote = await fetchMedia({ url: item.url, maxBytes })
    }
    catch (error) {
      const { message, statusCode } = errorDetails(error)
      return { url: item.url, ok: false, error: message, statusCode }
    }

    // Hashed before the storage reservation, so an asset the project already
    // holds costs neither quota nor an upload. The hash is of the bytes as
    // fetched — the same thing the provider hashes on the way in, before it
    // optimises anything — so the two can never disagree about identity.
    if (dedupe) {
      const contentHash = createHash('sha256').update(remote.buffer).digest('hex')
      const existing = await media.getAssetByContentHash!(input.projectId, contentHash).catch(() => null)
      if (existing) return describe(item.url, existing, true)
    }

    let storageReserved = false
    if (storageLimit > 0) {
      const reservation = await db.reserveStorageIfAllowed(input.workspaceId, remote.buffer.length, storageLimit)
      if (!reservation.allowed)
        return { url: item.url, ok: false, error: errorMessage('storage.quota_exceeded'), statusCode: 403 }
      storageReserved = true
    }

    try {
      const asset = await media.upload({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        file: remote.buffer,
        filename: item.filename?.trim() || remote.filename,
        contentType: remote.contentType,
        alt: item.alt,
        tags: item.tags,
        variants,
        uploadedBy: input.uploadedBy,
        source: input.source ?? 'url',
        skipStorageIncrement: storageReserved,
      })

      if (storageReserved) {
        const actualBytes = typeof asset.size === 'number' ? asset.size : 0
        const delta = actualBytes - remote.buffer.length
        if (delta !== 0)
          await db.incrementWorkspaceStorageBytes(input.workspaceId, delta).catch(() => {})
      }

      emitWebhookEvent(input.projectId, input.workspaceId, 'media.uploaded', {
        assetId: asset.id,
        filename: asset.filename,
        contentType: asset.contentType,
        sourceUrl: item.url,
      }).catch(() => {})

      return describe(item.url, asset, false)
    }
    catch (error) {
      if (storageReserved)
        await db.incrementWorkspaceStorageBytes(input.workspaceId, -remote.buffer.length).catch(() => {})
      const { message, statusCode } = errorDetails(error)
      return { url: item.url, ok: false, error: message, statusCode }
    }
  }

  // Bounded concurrency — remote hosts (and our own optimizer) are the limit.
  const concurrency = Math.max(1, Math.min(BULK_INGEST_MAX_CONCURRENCY, input.concurrency ?? 3))
  const ordered: BulkIngestItemResult[] = Array.from({ length: queue.length })
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (cursor < queue.length) {
      const index = cursor++
      ordered[index] = await ingestOne(queue[index]!)
    }
  }))
  results.push(...ordered)

  const map: Record<string, string> = {}
  for (const r of results) if (r.ok && r.deliveryUrl) map[r.url] = r.deliveryUrl

  return {
    requested: input.items.length,
    unique: queue.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    deduped: results.filter(r => r.deduped).length,
    results,
    map,
  }
}
