/**
 * CDN Provider interface.
 *
 * Abstracts object storage for CDN content delivery.
 * Interface lives in core (AGPL), implementations in ee/ (proprietary).
 *
 * Current impl: ee/cdn/cloudflare-cdn.ts (Cloudflare R2)
 * Future impls: AWS S3 + CloudFront, MinIO (on-premise)
 */

export interface CDNObject {
  path: string
  size: number
  contentType: string
  etag: string
}

export interface CDNProvider {
  /** Upload content to CDN storage. Path is relative to project namespace. */
  putObject: (projectId: string, path: string, data: string | Buffer, contentType: string) => Promise<CDNObject>

  /** Read content from CDN storage. Returns null if not found. */
  getObject: (projectId: string, path: string) => Promise<{ data: Buffer, contentType: string, etag: string } | null>

  /** Delete a single object. */
  deleteObject: (projectId: string, path: string) => Promise<void>

  /** Delete all objects under a prefix. Used for full rebuild or project deletion. */
  deletePrefix: (projectId: string, prefix: string) => Promise<void>

  /** List objects under a prefix. */
  listObjects: (projectId: string, prefix?: string) => Promise<CDNObject[]>

  /** Purge CDN edge cache for specific paths. Called after upload. */
  purgeCache: (projectId: string, paths?: string[]) => Promise<void>

  /** Get the storage key for an object (bucket-relative). */
  getStorageKey: (projectId: string, path: string) => string
}
