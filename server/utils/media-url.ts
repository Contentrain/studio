import type { MediaAsset } from '../providers/media'

/**
 * The per-project public media delivery base (no trailing slash):
 * `{cdnUrl || siteUrl}/api/cdn/v1/{projectId}`. The single seam for where
 * media resolves: with `NUXT_PUBLIC_CDN_URL` set, new URLs use the CDN host
 * (Cloudflare in front of the same route, docs/CDN_EDGE.md). Also handed to
 * the MCP Cloud loopback server (via the proxy) so external-agent writes
 * normalize media to the same URLs Studio's own write path produces.
 */
export function publicMediaBase(projectId: string): string {
  const pub = useRuntimeConfig().public
  return mediaBaseFor(String(pub.cdnUrl || pub.siteUrl || ''), projectId)
}

/**
 * Every base this instance serves a project's media under. With a separate
 * CDN host (`NUXT_PUBLIC_CDN_URL`) that is the CDN host and the app host:
 * both reach the same route, and content written before the CDN host was
 * set keeps the app-host URL until it is rehosted.
 */
export function ownMediaBases(projectId: string): string[] {
  const pub = useRuntimeConfig().public
  const bases = [mediaBaseFor(String(pub.cdnUrl || pub.siteUrl || ''), projectId)]
  if (pub.cdnUrl && pub.siteUrl) bases.push(mediaBaseFor(String(pub.siteUrl), projectId))
  return bases
}

/**
 * The media delivery base of any Studio instance + project:
 * `{siteUrl}/api/cdn/v1/{projectId}`. `publicMediaBase` is this instance's;
 * the media rehost uses it to recognise another instance's (or a previous
 * project id's) references.
 */
export function mediaBaseFor(siteUrl: string, projectId: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/api/cdn/v1/${projectId}`
}

/**
 * Build the delivery URL for a stored media path.
 *
 * Resolves to the CDN delivery endpoint (`/api/cdn/v1/{projectId}/{path}`).
 * For media binaries (`media/*`) this URL is browser-renderable without a key
 * when the project has `cdn_public_media` enabled (the default); otherwise it
 * requires a `delivery`-scoped Bearer key. Content JSON always needs a key.
 * Callers store the relative path as the SSOT; this turns it into a URL.
 */
export function toDeliveryUrl(projectId: string, path: string): string {
  return `${publicMediaBase(projectId)}/${path}`
}

/**
 * Whether a stored field value is a relative media-storage path (`media/...`)
 * rather than an already-absolute URL or external link. Only these are
 * rewritten to delivery URLs — `http(s)://`, `//`, and `data:` are left as-is.
 */
export function isStoredMediaPath(value: unknown): value is string {
  return typeof value === 'string' && /^media\//.test(value)
}

/**
 * Rewrite a stored media path to its absolute delivery URL. Non-media values
 * (external URLs, empty, non-strings) pass through untouched, so this is safe
 * to call on any field value.
 */
export function rewriteMediaUrl(projectId: string, value: unknown): unknown {
  return isStoredMediaPath(value) ? toDeliveryUrl(projectId, value) : value
}

/**
 * Resolve a value to THIS project's media storage path, when it is one.
 * Accepts either the bare stored form (`media/...`) or the project's own
 * absolute delivery URL; anything else — other hosts, other projects'
 * delivery URLs — returns null. Query/hash suffixes are stripped.
 */
export function ownMediaStoragePath(projectId: string, value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (/^media\//.test(value)) return value.split(/[?#]/)[0]!
  for (const base of ownMediaBases(projectId)) {
    const path = mediaStoragePathUnder(base, value)
    if (path) return path
  }
  return null
}

/**
 * The media storage path (`media/...`) of a delivery URL under `base`
 * (see `mediaBaseFor`), or null when the value is not one. Query/hash
 * suffixes are stripped.
 */
export function mediaStoragePathUnder(base: string, value: unknown): string | null {
  if (typeof value !== 'string') return null
  const prefix = `${base}/`
  if (!value.startsWith(prefix)) return null
  const rest = value.slice(prefix.length).split(/[?#]/)[0]!
  return /^media\//.test(rest) ? rest : null
}

/**
 * Decorate an asset with ready-to-use delivery URLs for the original and
 * every variant, keeping the raw storage paths intact.
 */
export function withMediaUrls(projectId: string, asset: MediaAsset): MediaAsset & {
  url: string
  variantUrls: Record<string, string>
} {
  return {
    ...asset,
    url: toDeliveryUrl(projectId, asset.originalPath),
    variantUrls: Object.fromEntries(
      Object.entries(asset.variants).map(([key, variant]) => [key, toDeliveryUrl(projectId, variant.path)]),
    ),
  }
}
