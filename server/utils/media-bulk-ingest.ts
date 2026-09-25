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

/** What storing one file needs, resolved once per batch: provider, plan caps, the workspace's storage ceiling. */
export interface MediaIngestContext {
  projectId: string
  workspaceId: string
  uploadedBy: string
  source: 'url' | 'agent' | 'repo'
  media: MediaProvider
  maxBytes: number
  variants: ReturnType<typeof resolveVariantConfigWithPlan>
  storageLimit: number
  dedupe: boolean
}

export async function createMediaIngestContext(input: {
  projectId: string
  workspaceId: string
  plan: Plan
  uploadedBy: string
  source: MediaIngestContext['source']
  dedupe?: boolean
  media?: MediaProvider
}): Promise<MediaIngestContext> {
  const media = input.media ?? useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  const db = useDatabaseProvider()
  const variants = resolveVariantConfigWithPlan(undefined, {
    hasCustomVariants: hasFeature(input.plan, 'media.custom_variants'),
    variantsPerFieldLimit: getPlanLimit(input.plan, 'media.variants_per_field'),
  })
  const workspace = await db.getWorkspaceById(input.workspaceId, 'id, overage_settings')
  const overageSettings = (workspace?.overage_settings as Record<string, boolean> | null) ?? {}
  const baseLimit = getPlanLimit(input.plan, 'media.storage_gb') * 1024 * 1024 * 1024

  return {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    uploadedBy: input.uploadedBy,
    source: input.source,
    media,
    maxBytes: getPlanLimit(input.plan, 'media.max_file_size_mb') * 1024 * 1024,
    variants,
    storageLimit: getEffectiveLimit(baseLimit, 'media.storage_gb', overageSettings),
    dedupe: input.dedupe !== false && typeof media.getAssetByContentHash === 'function',
  }
}

/** What a caller gets back for an asset, whether it was just made or already there. */
function describeAsset(projectId: string, ref: string, asset: { id: string, originalPath: string, variants?: Record<string, { path: string }> }, deduped: boolean): BulkIngestItemResult {
  return {
    url: ref,
    ok: true,
    assetId: asset.id,
    path: asset.originalPath,
    deliveryUrl: toDeliveryUrl(projectId, asset.originalPath),
    variantUrls: Object.fromEntries(Object.entries(asset.variants ?? {}).map(([key, v]) => [key, toDeliveryUrl(projectId, v.path)])),
    ...(deduped ? { deduped: true } : {}),
  }
}

/**
 * Store one already-validated file as an asset — the half of an ingest that
 * does not care where the bytes came from (a URL fetch, a repository blob).
 *
 * Dedupe on the content hash first (no quota, no upload for bytes the project
 * holds), then reserve this file's own bytes against the workspace's storage
 * ceiling — per file, so a batch that runs out of room stops at the file that
 * did not fit (`storage.quota_exceeded`, 403) instead of refusing up front —
 * upload, reconcile the reservation to the optimised size, and emit
 * `media.uploaded`. `ref` is what the caller calls this file (its URL or repo
 * path); it is echoed back as the result's `url`.
 */
export async function ingestMediaBytes(ctx: MediaIngestContext, item: { ref: string, remote: RemoteMedia, alt?: string, tags?: string[], filename?: string }): Promise<BulkIngestItemResult> {
  const { remote } = item
  const db = useDatabaseProvider()

  // Hashed before the storage reservation, so an asset the project already
  // holds costs neither quota nor an upload. The hash is of the bytes as
  // received — the same thing the provider hashes on the way in, before it
  // optimises anything — so the two can never disagree about identity.
  if (ctx.dedupe) {
    const contentHash = createHash('sha256').update(remote.buffer).digest('hex')
    const existing = await ctx.media.getAssetByContentHash!(ctx.projectId, contentHash).catch(() => null)
    if (existing) return describeAsset(ctx.projectId, item.ref, existing, true)
  }

  let storageReserved = false
  if (ctx.storageLimit > 0) {
    const reservation = await db.reserveStorageIfAllowed(ctx.workspaceId, remote.buffer.length, ctx.storageLimit)
    if (!reservation.allowed)
      return { url: item.ref, ok: false, error: errorMessage('storage.quota_exceeded'), statusCode: 403 }
    storageReserved = true
  }

  try {
    const asset = await ctx.media.upload({
      projectId: ctx.projectId,
      workspaceId: ctx.workspaceId,
      file: remote.buffer,
      filename: item.filename?.trim() || remote.filename,
      contentType: remote.contentType,
      alt: item.alt,
      tags: item.tags,
      variants: ctx.variants,
      uploadedBy: ctx.uploadedBy,
      source: ctx.source,
      skipStorageIncrement: storageReserved,
    })

    if (storageReserved) {
      const actualBytes = typeof asset.size === 'number' ? asset.size : 0
      const delta = actualBytes - remote.buffer.length
      if (delta !== 0)
        await db.incrementWorkspaceStorageBytes(ctx.workspaceId, delta).catch(() => {})
    }

    emitWebhookEvent(ctx.projectId, ctx.workspaceId, 'media.uploaded', {
      assetId: asset.id,
      filename: asset.filename,
      contentType: asset.contentType,
      sourceUrl: item.ref,
    }).catch(() => {})

    return describeAsset(ctx.projectId, item.ref, asset, false)
  }
  catch (error) {
    if (storageReserved)
      await db.incrementWorkspaceStorageBytes(ctx.workspaceId, -remote.buffer.length).catch(() => {})
    const { message, statusCode } = errorDetails(error)
    return { url: item.ref, ok: false, error: message, statusCode }
  }
}

export async function ingestMediaUrls(input: BulkIngestInput): Promise<BulkIngestReport> {
  const ctx = await createMediaIngestContext({ ...input, source: input.source ?? 'url' })
  const fetchMedia = input.fetchMedia ?? fetchRemoteMedia

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

  async function ingestOne(item: BulkIngestItem & { url: string }): Promise<BulkIngestItemResult> {
    let remote: RemoteMedia
    try {
      remote = await fetchMedia({ url: item.url, maxBytes: ctx.maxBytes })
    }
    catch (error) {
      const { message, statusCode } = errorDetails(error)
      return { url: item.url, ok: false, error: message, statusCode }
    }
    return ingestMediaBytes(ctx, { ref: item.url, remote, alt: item.alt, tags: item.tags, filename: item.filename })
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
