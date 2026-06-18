// Explicit relative imports — see index.get.ts.
import { resolveMediaApiContext } from '../../../../../utils/media-api'

/**
 * Bulk delete or tag media assets. Public media API — `media:write`.
 * Capped at 50 assets per call. Assets outside the key's project are
 * silently skipped (never cross-project).
 */
export default defineEventHandler(async (event) => {
  const ctx = await resolveMediaApiContext(event, {
    scope: 'media:write',
    feature: 'media.library',
    upgradeKey: 'media.library_upgrade',
  })

  const body = await readBody<{ action: 'delete' | 'tag', assetIds: string[], tags?: string[] }>(event)

  if (!body.action || !Array.isArray(body.assetIds) || body.assetIds.length === 0)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })
  if (body.assetIds.length > 50)
    throw createError({ statusCode: 400, message: errorMessage('media.bulk_limit_exceeded') })

  let affected = 0

  if (body.action === 'delete') {
    for (const assetId of body.assetIds) {
      const asset = await ctx.media.getAsset(assetId)
      if (asset && asset.projectId === ctx.projectId) {
        await ctx.media.delete(ctx.projectId, assetId)
        affected++
      }
    }
  }
  else if (body.action === 'tag') {
    if (!body.tags?.length)
      throw createError({ statusCode: 400, message: errorMessage('media.bulk_tags_required') })
    for (const assetId of body.assetIds) {
      const asset = await ctx.media.getAsset(assetId)
      if (asset && asset.projectId === ctx.projectId) {
        await ctx.media.updateMetadata(assetId, { tags: [...new Set([...(asset.tags ?? []), ...body.tags])] })
        affected++
      }
    }
  }
  else {
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })
  }

  return { action: body.action, affected }
})
