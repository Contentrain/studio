// Explicit relative imports — see index.get.ts.
import { resolveMediaApiContext } from '../../../../../utils/media-api'

/**
 * Delete a media asset. Public media API — `media:write`.
 */
export default defineEventHandler(async (event) => {
  const ctx = await resolveMediaApiContext(event, {
    scope: 'media:write',
    feature: 'media.library',
    upgradeKey: 'media.library_upgrade',
  })

  const assetId = getRouterParam(event, 'assetId')
  if (!assetId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  const existing = await ctx.media.getAsset(assetId)
  if (!existing || existing.projectId !== ctx.projectId)
    throw createError({ statusCode: 404, message: errorMessage('media.asset_not_found') })

  await ctx.media.delete(ctx.projectId, assetId)

  return { deleted: true }
})
