import { isStashExpired, readPromotion, readStash, recordPromotion, replaceStashMarkers, stashIdsIn } from './attachment-stash'
import { uploadWithStorageReservation } from './media-quota-upload'
import { toDeliveryUrl } from './media-url'
import { useCDNProvider, useMediaProvider } from './providers'

/**
 * Promote chat attachments a write references into the media library (#289).
 *
 * Content can only point at library assets. When the agent writes
 * `attachment:<id>` into a save — an image field, or a markdown image in a
 * body — the save promotes that attachment first: the one-day original if it
 * is still there, else this turn's downscaled copy (said so in the result),
 * through the same storage reservation as every upload. The marker becomes
 * the asset's delivery URL, so the committed value is what every other media
 * reference is. A full library refuses the write with a clear error rather
 * than saving a field that points nowhere.
 *
 * Promotion is decided by the write, never guessed from the chat: an
 * attachment that no write references stays ephemeral.
 */

export interface AttachmentPromotionContext {
  workspaceId: string
  projectId: string
  userId: string
  plan: string
  cdnEnabled: boolean
  /** Effective storage limit in bytes, as the upload routes compute it. */
  storageLimitBytes: number
  /** This turn's downscaled copies, by stash id (`validateAttachmentBlocks`). */
  downscaled: Map<string, { buffer: Buffer, contentType: string, filename: string }>
}

export interface PromotedAttachment {
  attachment: string
  path: string
  url: string
  /** Promoted from the downscaled copy because the original had expired. */
  downscaled?: true
}

function collectIds(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const id of stashIdsIn(value)) into.add(id)
  }
  else if (Array.isArray(value)) {
    for (const item of value) collectIds(item, into)
  }
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectIds(item, into)
  }
}

function replaceIn(value: unknown, urlFor: (id: string) => string | undefined): unknown {
  if (typeof value === 'string') return replaceStashMarkers(value, urlFor)
  if (Array.isArray(value)) return value.map(item => replaceIn(item, urlFor))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceIn(item, urlFor)]))
  return value
}

export function hasAttachmentMarker(value: unknown): boolean {
  const ids = new Set<string>()
  collectIds(value, ids)
  return ids.size > 0
}

/**
 * Promote every attachment `value` references and return a copy with the
 * markers replaced by delivery URLs. The input is never mutated — it is the
 * model's own tool input, which history replays byte-for-byte.
 */
export async function promoteAttachmentMarkers<T>(
  value: T,
  ctx: AttachmentPromotionContext,
): Promise<{ value: T, promoted: PromotedAttachment[] } | { error: string }> {
  const ids = new Set<string>()
  collectIds(value, ids)
  if (ids.size === 0) return { value, promoted: [] }

  const media = useMediaProvider()
  const cdn = useCDNProvider()
  if (!media || !cdn || !hasFeature(ctx.plan, 'media.upload'))
    return { error: errorMessage('attachment.media_unavailable') }
  if (!ctx.cdnEnabled)
    return { error: errorMessage('attachment.cdn_disabled') }

  const scope = { workspaceId: ctx.workspaceId, projectId: ctx.projectId }
  const promoted: PromotedAttachment[] = []
  const urls = new Map<string, string>()

  for (const id of ids) {
    // Written once already (an earlier save in this conversation): reuse the asset.
    const existing = isStashExpired(id) ? null : await readPromotion(cdn, scope, id)
    if (existing) {
      const url = toDeliveryUrl(ctx.projectId, existing)
      urls.set(id, url)
      promoted.push({ attachment: id, path: existing, url })
      continue
    }

    const original = await readStash(cdn, scope, id)
    const fallback = original ? null : ctx.downscaled.get(id)
    const source = original ?? fallback
    if (!source) return { error: errorMessage('attachment.promotion_expired', { id }) }

    const upload = await uploadWithStorageReservation({
      media,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      userId: ctx.userId,
      buffer: source.buffer,
      filename: source.filename,
      contentType: source.contentType,
      storageLimitBytes: ctx.storageLimitBytes,
    })
    if (!upload.ok)
      return { error: errorMessage(upload.reason === 'quota' ? 'attachment.promotion_quota_exceeded' : 'attachment.media_upload_failed') }

    const path = upload.asset.originalPath
    await recordPromotion(cdn, scope, id, path).catch(() => {})
    const url = toDeliveryUrl(ctx.projectId, path)
    urls.set(id, url)
    promoted.push({ attachment: id, path, url, ...(fallback ? { downscaled: true as const } : {}) })
  }

  return { value: replaceIn(value, id => urls.get(id)) as T, promoted }
}
