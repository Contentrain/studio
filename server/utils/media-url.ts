import type { MediaAsset } from '../providers/media'

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
  const base = String(useRuntimeConfig().public.siteUrl ?? '').replace(/\/+$/, '')
  return `${base}/api/cdn/v1/${projectId}/${path}`
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
