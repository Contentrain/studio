import type { MediaAsset } from '../providers/media'

/**
 * Build the delivery URL for a stored media path.
 *
 * This is the Bearer-keyed CDN delivery endpoint (`/api/cdn/v1/...`),
 * which is what build tools / agents holding a `delivery`-scoped key use
 * to fetch an asset. Public, no-auth browser delivery (a `<img src>` that
 * works without a key) requires a CDN custom domain, which is ee/roadmap
 * (`cdn.custom_domain`). Callers store the path; how it resolves to a
 * public URL follows the project's own CDN delivery setup.
 */
export function toDeliveryUrl(projectId: string, path: string): string {
  const base = String(useRuntimeConfig().public.siteUrl ?? '').replace(/\/+$/, '')
  return `${base}/api/cdn/v1/${projectId}/${path}`
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
