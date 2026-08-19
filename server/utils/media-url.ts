import type { MediaAsset } from '../providers/media'

/**
 * The per-project public media delivery base (no trailing slash):
 * `{siteUrl}/api/cdn/v1/{projectId}`. The single seam for where media resolves
 * — a CDN custom domain (ee/roadmap) would swap the host here. Also handed to
 * the MCP Cloud loopback server (via the proxy) so external-agent writes
 * normalize media to the same URLs Studio's own write path produces.
 */
export function publicMediaBase(projectId: string): string {
  const base = String(useRuntimeConfig().public.siteUrl ?? '').replace(/\/+$/, '')
  return `${base}/api/cdn/v1/${projectId}`
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
  const prefix = `${publicMediaBase(projectId)}/`
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
