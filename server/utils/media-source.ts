/**
 * Where an upload's source bytes live.
 *
 * An image upload is re-encoded into the delivery master (`media/original/<id>.webp`, metadata stripped, ≤ 4096 px) —
 * the file the site serves. The bytes the person actually uploaded are kept apart, byte for byte, under their own
 * prefix. That prefix is deliberately NOT under `media/`: the public CDN route serves `media/*` keyless, the stored
 * media path (`isStoredMediaPath`) is `media/…`, and the rehost lists `media/`. A source outside it can neither be
 * fetched by delivery nor referenced from content. Only the authed Studio route (members) reads it.
 */

export const MEDIA_SOURCE_PREFIX = 'media-source/'

/** True for a path in the private source area (never deliverable). */
export function isMediaSourcePath(path: string): boolean {
  return path.startsWith(MEDIA_SOURCE_PREFIX)
}

const SOURCE_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

/** `media-source/<assetId>.<ext>` — the extension from the content type, never from the filename. */
export function mediaSourcePath(assetId: string, contentType: string): string {
  return `${MEDIA_SOURCE_PREFIX}${assetId}.${SOURCE_EXTENSION[contentType] ?? 'bin'}`
}
