/**
 * Sharp-based MediaProvider implementation.
 *
 * Full pipeline: validate → optimize → blurhash → variants → R2 upload → DB insert.
 * Uses CDNProvider for R2 storage (same bucket as content CDN, media/ prefix).
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CDNProvider } from '../../server/providers/cdn'
import type {
  MediaAsset,
  MediaListOptions,
  MediaProvider,
  MediaUsageRef,
  UploadOptions,
  VariantConfig,
} from '../../server/providers/media'
import {
  createMediaAsset,
  deleteMediaAsset,
  getMediaAsset,
  getMediaUsage,
  listMediaAssets,
  removeMediaUsage,
  trackMediaUsage,
  updateMediaAsset,
  updateWorkspaceStorageBytes,
} from '../../server/utils/db'
import { optimizeImage } from './media-optimizer'
import { generateVariants } from './variant-generator'
import { calculateBlurhash } from './blurhash-calculator'

export interface SharpMediaProviderConfig {
  cdn: CDNProvider
  admin: SupabaseClient
}

function rowToAsset(row: ReturnType<typeof getMediaAsset> extends Promise<infer T> ? NonNullable<T> : never, usedIn: MediaUsageRef[] = []): MediaAsset {
  return {
    id: row.id,
    projectId: row.project_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size_bytes,
    width: row.width ?? 0,
    height: row.height ?? 0,
    format: row.format,
    blurhash: row.blurhash,
    alt: row.alt,
    focalPoint: row.focal_point,
    variants: row.variants,
    tags: row.tags,
    uploadedBy: row.uploaded_by,
    source: row.source as MediaAsset['source'],
    originalPath: row.original_path,
    contentHash: row.content_hash,
    usedIn,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createSharpMediaProvider(config: SharpMediaProviderConfig): MediaProvider {
  const { cdn, admin } = config

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
        }
      }

      // Total storage used (original + all variants)
      const totalBytes = optimized.size + Object.values(variantMap).reduce((sum, v) => sum + v.size, 0)

      // Insert DB row
      const row = await createMediaAsset(admin, {
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

      // Update workspace storage counter
      await updateWorkspaceStorageBytes(admin, workspaceId, totalBytes)

      return rowToAsset(row)
    },

    async regenerateVariants(assetId: string, variants: Record<string, VariantConfig>): Promise<MediaAsset> {
      const row = await getMediaAsset(admin, assetId)
      if (!row) throw createError({ statusCode: 404, message: 'Asset not found' })

      // Fetch original from R2
      const original = await cdn.getObject(row.project_id, row.original_path)
      if (!original) throw createError({ statusCode: 404, message: 'Original file not found in storage' })

      // Delete old variants from R2
      const oldVariants = row.variants as Record<string, { path: string, size: number }>
      let freedBytes = 0
      for (const v of Object.values(oldVariants)) {
        await cdn.deleteObject(row.project_id, v.path)
        freedBytes += v.size
      }

      // Generate new variants
      const generated = await generateVariants(original.data, assetId, variants)
      const variantMap: Record<string, { path: string, width: number, height: number, format: string, size: number }> = {}
      let newBytes = 0
      for (const v of generated) {
        await cdn.putObject(row.project_id, v.variant.path, v.buffer, `image/${v.variant.format}`)
        variantMap[v.name] = v.variant
        newBytes += v.variant.size
      }

      // Recalculate blurhash
      const blurhash = await calculateBlurhash(original.data)

      // Update DB
      const updated = await updateMediaAsset(admin, assetId, { variants: variantMap, blurhash })

      // Update storage delta
      await updateWorkspaceStorageBytes(admin, row.workspace_id, newBytes - freedBytes)

      return rowToAsset(updated)
    },

    async delete(projectId: string, assetId: string): Promise<void> {
      const row = await getMediaAsset(admin, assetId)
      if (!row) return

      // Delete original from R2
      await cdn.deleteObject(projectId, row.original_path)

      // Delete variants from R2
      const variants = row.variants as Record<string, { path: string, size: number }>
      for (const v of Object.values(variants)) {
        await cdn.deleteObject(projectId, v.path)
      }

      // Delete DB row (cascades to media_usage)
      await deleteMediaAsset(admin, assetId)

      // Update workspace storage counter
      await updateWorkspaceStorageBytes(admin, row.workspace_id, -row.size_bytes)
    },

    async getAsset(assetId: string): Promise<MediaAsset | null> {
      const row = await getMediaAsset(admin, assetId)
      if (!row) return null
      const usage = await getMediaUsage(admin, assetId)
      return rowToAsset(row, usage)
    },

    async listAssets(projectId: string, options?: MediaListOptions) {
      const result = await listMediaAssets(admin, projectId, options)
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

      const row = await updateMediaAsset(admin, assetId, updates as Parameters<typeof updateMediaAsset>[2])
      return rowToAsset(row)
    },

    async trackUsage(assetId: string, usage: MediaUsageRef) {
      const row = await getMediaAsset(admin, assetId)
      if (!row) return
      await trackMediaUsage(admin, {
        asset_id: assetId,
        project_id: row.project_id,
        model_id: usage.modelId,
        entry_id: usage.entryId,
        field_id: usage.fieldId,
        locale: usage.locale,
      })
    },

    async removeUsage(assetId: string, usage: MediaUsageRef) {
      await removeMediaUsage(admin, {
        asset_id: assetId,
        model_id: usage.modelId,
        entry_id: usage.entryId,
        field_id: usage.fieldId,
        locale: usage.locale,
      })
    },
  }
}
