/**
 * Media asset and media usage methods for the Supabase DatabaseProvider.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type MediaMethods = Pick<
  DatabaseProvider,
  | 'createMediaAsset'
  | 'getMediaAsset'
  | 'listMediaAssets'
  | 'updateMediaAsset'
  | 'deleteMediaAsset'
  | 'trackMediaUsage'
  | 'removeMediaUsage'
  | 'getMediaUsage'
>

export function mediaMethods(): MediaMethods {
  return {
    async createMediaAsset(asset) {
      const { data, error } = await getAdmin()
        .from('media_assets')
        .insert(asset)
        .select()
        .single()

      if (error || !data) {
        throw createError({ statusCode: 500, message: errorMessage('media.create_failed', { detail: error?.message ?? 'Unknown error' }) })
      }
      return data as DatabaseRow
    },

    async getMediaAsset(assetId) {
      const { data } = await getAdmin()
        .from('media_assets')
        .select('*')
        .eq('id', assetId)
        .single()

      return (data as DatabaseRow) ?? null
    },

    async listMediaAssets(projectId, options) {
      const page = options?.page ?? 1
      const limit = options?.limit ?? 50
      const offset = (page - 1) * limit

      let query = getAdmin()
        .from('media_assets')
        .select('*', { count: 'exact' })
        .eq('project_id', projectId)

      if (options?.search) {
        query = query.or(`filename.ilike.%${options.search}%,alt.ilike.%${options.search}%`)
      }
      if (options?.tags?.length) {
        query = query.overlaps('tags', options.tags)
      }
      if (options?.contentType) {
        query = query.ilike('content_type', `${options.contentType}%`)
      }

      const sortColumn = options?.sort === 'name' ? 'filename' : options?.sort === 'size' ? 'size_bytes' : 'created_at'
      const ascending = options?.sort === 'name' || options?.sort === 'oldest'

      const { data, count, error } = await query
        .order(sortColumn, { ascending })
        .range(offset, offset + limit - 1)

      if (error) {
        throw createError({ statusCode: 500, message: errorMessage('media.list_failed', { detail: error.message }) })
      }
      return { assets: (data ?? []) as DatabaseRow[], total: count ?? 0 }
    },

    async updateMediaAsset(assetId, updates) {
      const { data, error } = await getAdmin()
        .from('media_assets')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', assetId)
        .select()
        .single()

      if (error || !data) {
        throw createError({ statusCode: 500, message: errorMessage('media.update_failed', { detail: error?.message ?? 'Unknown error' }) })
      }
      return data as DatabaseRow
    },

    async deleteMediaAsset(assetId) {
      const { data } = await getAdmin()
        .from('media_assets')
        .delete()
        .eq('id', assetId)
        .select()
        .single()

      return (data as DatabaseRow) ?? null
    },

    // ─── Media Usage ───

    async trackMediaUsage(usage) {
      await getAdmin()
        .from('media_usage')
        .upsert(usage, { onConflict: 'asset_id,model_id,entry_id,field_id,locale' })
    },

    async removeMediaUsage(usage) {
      await getAdmin()
        .from('media_usage')
        .delete()
        .eq('asset_id', usage.asset_id)
        .eq('model_id', usage.model_id)
        .eq('entry_id', usage.entry_id)
        .eq('field_id', usage.field_id)
        .eq('locale', usage.locale)
    },

    async getMediaUsage(assetId) {
      const { data } = await getAdmin()
        .from('media_usage')
        .select('model_id, entry_id, field_id, locale')
        .eq('asset_id', assetId)

      return data ?? []
    },
  }
}
