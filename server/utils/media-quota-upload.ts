import type { MediaAsset, MediaProvider } from '../providers/media'
import { resolveVariantConfig } from './media-variants'
import { useDatabaseProvider } from './providers'

/**
 * Upload into the media library behind the workspace storage reservation —
 * the same atomic reserve → upload → settle/release every media upload path
 * makes (media route, bulk ingest, MCP media facet). Shared by chat
 * attachments sent to the library and attachments promoted by a write (#289).
 */
export async function uploadWithStorageReservation(input: {
  media: MediaProvider
  workspaceId: string
  projectId: string
  userId: string
  buffer: Buffer
  filename: string
  contentType: string
  /** Effective limit in bytes (plan limit, raised by overage). `0`/absent = unlimited. */
  storageLimitBytes?: number
}): Promise<{ ok: true, asset: MediaAsset } | { ok: false, reason: 'quota' | 'failed' }> {
  const db = useDatabaseProvider()
  const reserveBytes = input.buffer.length
  let storageReserved = false
  if (input.storageLimitBytes && input.storageLimitBytes > 0) {
    const reservation = await db.reserveStorageIfAllowed(input.workspaceId, reserveBytes, input.storageLimitBytes).catch(() => null)
    if (!reservation) return { ok: false, reason: 'failed' }
    if (!reservation.allowed) return { ok: false, reason: 'quota' }
    storageReserved = true
  }
  try {
    const asset = await input.media.upload({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      file: input.buffer,
      filename: input.filename,
      contentType: input.contentType,
      variants: resolveVariantConfig(undefined),
      uploadedBy: input.userId,
      source: 'upload',
      skipStorageIncrement: storageReserved,
    })
    if (storageReserved) {
      const delta = (typeof asset.size === 'number' ? asset.size : 0) - reserveBytes
      if (delta !== 0) await db.incrementWorkspaceStorageBytes(input.workspaceId, delta).catch(() => {})
    }
    return { ok: true, asset }
  }
  catch {
    if (storageReserved) await db.incrementWorkspaceStorageBytes(input.workspaceId, -reserveBytes).catch(() => {})
    return { ok: false, reason: 'failed' }
  }
}
