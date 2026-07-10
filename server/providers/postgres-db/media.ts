/**
 * Media asset and media usage methods for the plain-Postgres
 * DatabaseProvider. Behavior parity with supabase-db/media.ts.
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

/** jsonb columns must be stringified — node-pg serializes raw JS arrays as Postgres arrays. */
function serializeAssetJson(asset: Record<string, unknown>): Record<string, unknown> {
  const out = { ...asset }
  for (const key of ['focal_point', 'variants']) {
    if (out[key] !== undefined && out[key] !== null && typeof out[key] === 'object')
      out[key] = JSON.stringify(out[key])
  }
  return out
}

export function mediaMethods(): MediaMethods {
  return {
    async createMediaAsset(asset) {
      try {
        const row = await getAdmin()
          .insertInto('media_assets')
          .values(serializeAssetJson({ ...asset }) as never)
          .returningAll()
          .executeTakeFirst()

        if (!row) throw new Error('empty insert response')
        return row as DatabaseRow
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: errorMessage('media.create_failed', { detail: error instanceof Error ? error.message : 'Unknown error' }),
        })
      }
    },

    async getMediaAsset(assetId) {
      // Failure reads as null (the Supabase impl never checks the error).
      try {
        const row = await getAdmin()
          .selectFrom('media_assets')
          .selectAll()
          .where('id', '=', assetId)
          .executeTakeFirst()

        return (row as DatabaseRow | undefined) ?? null
      }
      catch {
        return null
      }
    },

    async listMediaAssets(projectId, options) {
      const page = options?.page ?? 1
      const limit = options?.limit ?? 50
      const offset = (page - 1) * limit

      try {
        let base = getAdmin()
          .selectFrom('media_assets')
          .where('project_id', '=', projectId)

        if (options?.search) {
          const pattern = `%${options.search}%`
          base = base.where(eb => eb.or([
            eb('filename', 'ilike', pattern),
            eb('alt', 'ilike', pattern),
          ]))
        }
        if (options?.tags?.length) {
          // PostgREST overlaps() = the && array operator
          base = base.where(eb => eb('tags', '&&' as never, eb.val(options.tags) as never))
        }
        if (options?.contentType)
          base = base.where('content_type', 'ilike', `${options.contentType}%`)

        const totalRow = await base
          .select(eb => eb.fn.countAll().as('total'))
          .executeTakeFirst()

        const sortColumn = options?.sort === 'name' ? 'filename' : options?.sort === 'size' ? 'size_bytes' : 'created_at'
        const ascending = options?.sort === 'name' || options?.sort === 'oldest'

        const rows = await base
          .selectAll()
          .orderBy(sortColumn, ascending ? 'asc' : 'desc')
          .limit(limit)
          .offset(offset)
          .execute()

        return { assets: rows as DatabaseRow[], total: Number(totalRow?.total ?? 0) }
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: errorMessage('media.list_failed', { detail: error instanceof Error ? error.message : 'unknown' }),
        })
      }
    },

    async updateMediaAsset(assetId, updates) {
      try {
        const row = await getAdmin()
          .updateTable('media_assets')
          .set({ ...serializeAssetJson(updates), updated_at: new Date().toISOString() } as never)
          .where('id', '=', assetId)
          .returningAll()
          .executeTakeFirst()

        if (!row) throw new Error('empty update response')
        return row as DatabaseRow
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: errorMessage('media.update_failed', { detail: error instanceof Error ? error.message : 'Unknown error' }),
        })
      }
    },

    async deleteMediaAsset(assetId) {
      // Failure reads as null (the Supabase impl never checks the error).
      try {
        const row = await getAdmin()
          .deleteFrom('media_assets')
          .where('id', '=', assetId)
          .returningAll()
          .executeTakeFirst()

        return (row as DatabaseRow | undefined) ?? null
      }
      catch {
        return null
      }
    },

    // ─── Media Usage ───

    async trackMediaUsage(usage) {
      // Fire-and-forget in the Supabase impl — mirror it.
      try {
        await getAdmin()
          .insertInto('media_usage')
          .values(usage as never)
          .onConflict(oc => oc
            .columns(['asset_id', 'model_id', 'entry_id', 'field_id', 'locale'])
            .doNothing())
          .execute()
      }
      catch {
        // parity: swallowed
      }
    },

    async removeMediaUsage(usage) {
      try {
        await getAdmin()
          .deleteFrom('media_usage')
          .where('asset_id', '=', usage.asset_id)
          .where('model_id', '=', usage.model_id)
          .where('entry_id', '=', usage.entry_id)
          .where('field_id', '=', usage.field_id)
          .where('locale', '=', usage.locale)
          .execute()
      }
      catch {
        // parity: swallowed
      }
    },

    async getMediaUsage(assetId) {
      // Failure reads as [] (the Supabase impl never checks the error).
      try {
        return await getAdmin()
          .selectFrom('media_usage')
          .select(['model_id', 'entry_id', 'field_id', 'locale'])
          .where('asset_id', '=', assetId)
          .execute() as DatabaseRow[]
      }
      catch {
        return []
      }
    },
  }
}
