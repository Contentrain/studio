/**
 * Sharp-based MediaProvider implementation.
 *
 * Full pipeline: validate → optimize → blurhash → variants → R2 upload → DB insert.
 * Uses CDNProvider for R2 storage (same bucket as content CDN, media/ prefix).
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

import { createHash } from 'node:crypto'
import type { CDNProvider } from '../../server/providers/cdn'
import type {
  MediaAsset,
  MediaListOptions,
  MediaProvider,
  MediaUsageRef,
  UploadOptions,
  VariantConfig,
} from '../../server/providers/media'
import type { DatabaseProvider, DatabaseRow } from '../../server/providers/database'
import { optimizeImage } from './media-optimizer'
import { generateVariants } from './variant-generator'
import { calculateBlurhash } from './blurhash-calculator'

export interface SharpMediaProviderConfig {
  cdn: CDNProvider
  db: DatabaseProvider
}

function rowToAsset(row: DatabaseRow, usedIn: MediaUsageRef[] = []): MediaAsset {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    filename: row.filename as string,
    contentType: row.content_type as string,
    size: (row.size_bytes as number) ?? 0,
    width: (row.width as number) ?? 0,
    height: (row.height as number) ?? 0,
    format: row.format as string,
    blurhash: (row.blurhash as string) ?? null,
    alt: (row.alt as string) ?? null,
    focalPoint: row.focal_point as MediaAsset['focalPoint'],
    variants: row.variants as MediaAsset['variants'],
    tags: (row.tags as string[]) ?? [],
    uploadedBy: row.uploaded_by as string,
    source: row.source as MediaAsset['source'],
    originalPath: row.original_path as string,
    contentHash: row.content_hash as string,
    usedIn,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export function createSharpMediaProvider(config: SharpMediaProviderConfig): MediaProvider {
  const { cdn, db } = config

  return {
    async upload(options: UploadOptions): Promise<MediaAsset> {
      const { projectId, workspaceId, file, filename, contentType, uploadedBy } = options

      // Content hash for duplicate detection
      const contentHash = createHash('sha256').update(file).digest('hex')

      // Determine asset ID (uuid-like from hash prefix + random)
      const assetId = crypto.randomUUID()
      const ext = 'webp'

      // Optimize original
      const isImage = contentType.startsWith('image/') && contentType !== 'image/svg+xml'
      let optimized: { buffer: Buffer, width: number, height: number, format: string, size: number }

      if (isImage) {
        optimized = await optimizeImage(file, contentType)
      }
      else {
        // Non-image files: store as-is
        optimized = {
          buffer: file,
          width: 0,
          height: 0,
          format: filename.split('.').pop() ?? 'bin',
          size: file.length,
        }
      }

      // Upload original to R2
      const originalPath = `media/original/${assetId}.${isImage ? ext : optimized.format}`
      await cdn.putObject(projectId, originalPath, optimized.buffer, isImage ? 'image/webp' : contentType)

      // Track uploaded paths for cleanup on failure
      const uploadedPaths: string[] = [originalPath]

      try {
        // Calculate blurhash (images only)
        let blurhash: string | null = null
        if (isImage) {
          blurhash = await calculateBlurhash(optimized.buffer)
        }

        // Generate and upload variants (images only)
        const variantMap: Record<string, { path: string, width: number, height: number, format: string, size: number }> = {}

        if (isImage && Object.keys(options.variants).length > 0) {
          const generated = await generateVariants(optimized.buffer, assetId, options.variants)
          for (const v of generated) {
            await cdn.putObject(projectId, v.variant.path, v.buffer, `image/${v.variant.format}`)
            variantMap[v.name] = v.variant
            uploadedPaths.push(v.variant.path)
          }
        }

        // Total storage used (original + all variants)
        const totalBytes = optimized.size + Object.values(variantMap).reduce((sum, v) => sum + v.size, 0)

        // Insert DB row
        const row = await db.createMediaAsset({
          project_id: projectId,
          workspace_id: workspaceId,
          filename,
          content_type: contentType,
          size_bytes: totalBytes,
          content_hash: contentHash,
          width: optimized.width,
          height: optimized.height,
          format: optimized.format,
          blurhash,
          focal_point: null,
          duration_seconds: null,
          alt: options.alt ?? null,
          tags: options.tags ?? [],
          original_path: originalPath,
          variants: variantMap,
          uploaded_by: uploadedBy,
          source: options.source ?? 'upload',
        })

        // Update workspace storage counter (skip when caller manages quota via reserve/adjust)
        if (!options.skipStorageIncrement) {
          await db.incrementWorkspaceStorageBytes(workspaceId, totalBytes)
        }

        return rowToAsset(row)
      }
      catch (e) {
        // Cleanup orphaned blobs on failure
        for (const path of uploadedPaths) {
          try {
            await cdn.deleteObject(projectId, path)
          }
          catch { /* best-effort cleanup */ }
        }
        throw e
      }
    },

    async regenerateVariants(assetId: string, variants: Record<string, VariantConfig>): Promise<MediaAsset> {
      const row = await db.getMediaAsset(assetId)
      if (!row) throw createError({ statusCode: 404, message: 'Asset not found' })

      // Fetch original from R2
      const original = await cdn.getObject(row.project_id as string, row.original_path as string)
      if (!original) throw createError({ statusCode: 404, message: 'Original file not found in storage' })

      // Generate NEW variants first (before deleting old ones)
      const generated = await generateVariants(original.data, assetId, variants)
      const variantMap: Record<string, { path: string, width: number, height: number, format: string, size: number }> = {}
      let newBytes = 0

      // Upload NEW variants
      for (const v of generated) {
        await cdn.putObject(row.project_id as string, v.variant.path, v.buffer, `image/${v.variant.format}`)
        variantMap[v.name] = v.variant
        newBytes += v.variant.size
      }

      // NOW safe to delete old variants (new ones are durable)
      const oldVariants = row.variants as Record<string, { path: string, size: number }>
      let freedBytes = 0
      for (const v of Object.values(oldVariants)) {
        // Only delete if path differs from new variant (avoid deleting if same path reused)
        const isReused = Object.values(variantMap).some(nv => nv.path === v.path)
        if (!isReused) {
          await cdn.deleteObject(row.project_id as string, v.path)
        }
        freedBytes += v.size
      }

      // Recalculate blurhash
      const blurhash = await calculateBlurhash(original.data)

      // Update DB
      const updated = await db.updateMediaAsset(assetId, { variants: variantMap, blurhash })

      // Update storage delta
      await db.incrementWorkspaceStorageBytes(row.workspace_id as string, newBytes - freedBytes)

      return rowToAsset(updated)
    },

    async delete(projectId: string, assetId: string): Promise<void> {
      const row = await db.getMediaAsset(assetId)
      if (!row) return

      // Delete original from R2
      await cdn.deleteObject(projectId, row.original_path as string)

      // Delete variants from R2
      const variants = row.variants as Record<string, { path: string, size: number }>
      for (const v of Object.values(variants)) {
        await cdn.deleteObject(projectId, v.path)
      }

      // Delete DB row (cascades to media_usage)
      await db.deleteMediaAsset(assetId)

      // Update workspace storage counter
      await db.incrementWorkspaceStorageBytes(row.workspace_id as string, -(row.size_bytes as number))
    },

    async getAsset(assetId: string): Promise<MediaAsset | null> {
      const row = await db.getMediaAsset(assetId)
      if (!row) return null
      const usageRows = await db.getMediaUsage(assetId)
      const usage: MediaUsageRef[] = usageRows.map(u => ({
        modelId: u.model_id as string,
        entryId: u.entry_id as string,
        fieldId: u.field_id as string,
        locale: u.locale as string,
      }))
      return rowToAsset(row, usage)
    },

    async listAssets(projectId: string, options?: MediaListOptions) {
      const result = await db.listMediaAssets(projectId, options)
      return {
        assets: result.assets.map(row => rowToAsset(row)),
        total: result.total,
      }
    },

    async updateMetadata(assetId: string, metadata) {
      const updates: Record<string, unknown> = {}
      if (metadata.alt !== undefined) updates.alt = metadata.alt
      if (metadata.tags !== undefined) updates.tags = metadata.tags
      if (metadata.focalPoint !== undefined) updates.focal_point = metadata.focalPoint

      const row = await db.updateMediaAsset(assetId, updates)
      return rowToAsset(row)
    },

    async trackUsage(assetId: string, usage: MediaUsageRef) {
      const row = await db.getMediaAsset(assetId)
      if (!row) return
      await db.trackMediaUsage({
        asset_id: assetId,
        project_id: row.project_id as string,
        model_id: usage.modelId,
        entry_id: usage.entryId,
        field_id: usage.fieldId,
        locale: usage.locale,
      })
    },

    async removeUsage(assetId: string, usage: MediaUsageRef) {
      await db.removeMediaUsage({
        asset_id: assetId,
        model_id: usage.modelId,
        entry_id: usage.entryId,
        field_id: usage.fieldId,
        locale: usage.locale,
      })
    },
  }
}
