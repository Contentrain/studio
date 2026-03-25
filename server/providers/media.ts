/**
 * Media Provider interface.
 *
 * Abstracts media upload, processing, variant generation, and metadata management.
 * Interface lives in core (AGPL), implementations in ee/ (proprietary).
 *
 * Current impl: ee/media/sharp-processor.ts (Sharp + CDNProvider R2)
 * Future impls: ffmpeg-based video processor, external service adapters
 *
 * Storage split:
 * - Binary files → R2 via CDNProvider (media/ prefix)
 * - Enriched metadata (variants, blurhash, dimensions) → DB (media_assets table)
 * - Core metadata (filename, path, alt, tags) → git (.contentrain/content/system/_media/)
 */

export interface MediaAsset {
  id: string
  projectId: string
  filename: string
  contentType: string
  size: number
  width: number
  height: number
  format: string
  blurhash: string | null
  alt: string | null
  focalPoint: { x: number, y: number } | null
  variants: Record<string, MediaVariant>
  tags: string[]
  uploadedBy: string
  source: 'upload' | 'url' | 'connector' | 'agent'
  originalPath: string
  contentHash: string
  usedIn: MediaUsageRef[]
  createdAt: string
  updatedAt: string
}

export interface MediaVariant {
  path: string
  width: number
  height: number
  format: string
  size: number
}

export interface MediaUsageRef {
  modelId: string
  entryId: string
  fieldId: string
  locale: string
}

export interface VariantConfig {
  width: number
  height?: number
  fit: 'cover' | 'contain' | 'fill' | 'inside'
  quality?: number
  format?: 'webp' | 'jpeg' | 'png' | 'avif' | 'auto'
}

export interface UploadOptions {
  projectId: string
  workspaceId: string
  file: Buffer
  filename: string
  contentType: string
  alt?: string
  tags?: string[]
  variants: Record<string, VariantConfig>
  uploadedBy: string
  source?: 'upload' | 'url' | 'connector' | 'agent'
}

export interface MediaListOptions {
  search?: string
  tags?: string[]
  contentType?: string
  page?: number
  limit?: number
  sort?: 'newest' | 'oldest' | 'name' | 'size'
}

export interface MediaProvider {
  /** Upload, optimize, and generate variants. Returns the created asset. */
  upload: (options: UploadOptions) => Promise<MediaAsset>

  /** Re-generate variants for an existing asset (when field config changes). */
  regenerateVariants: (assetId: string, variants: Record<string, VariantConfig>) => Promise<MediaAsset>

  /** Delete asset and all its variants from storage + DB. */
  delete: (projectId: string, assetId: string) => Promise<void>

  /** Get asset metadata from DB. */
  getAsset: (assetId: string) => Promise<MediaAsset | null>

  /** List assets for a project with filtering and pagination. */
  listAssets: (projectId: string, options?: MediaListOptions) => Promise<{ assets: MediaAsset[], total: number }>

  /** Update asset metadata (alt, tags, focal point). */
  updateMetadata: (assetId: string, metadata: {
    alt?: string
    tags?: string[]
    focalPoint?: { x: number, y: number }
  }) => Promise<MediaAsset>

  /** Track asset usage in content entry field. */
  trackUsage: (assetId: string, usage: MediaUsageRef) => Promise<void>

  /** Remove asset usage tracking. */
  removeUsage: (assetId: string, usage: MediaUsageRef) => Promise<void>
}
