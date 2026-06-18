// Explicit relative imports — see index.get.ts.
import { resolveMediaApiContext } from '../../../../../utils/media-api'
import { withMediaUrls } from '../../../../../utils/media-url'

/**
 * Get a single media asset. Public media API — `media:read`.
 */
export default defineEventHandler(async (event) => {
  const ctx = await resolveMediaApiContext(event, {
    scope: 'media:read',
    feature: 'media.library',
    upgradeKey: 'media.library_upgrade',
  })

  const assetId = getRouterParam(event, 'assetId')
  if (!assetId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  const asset = await ctx.media.getAsset(assetId)
  if (!asset || asset.projectId !== ctx.projectId)
    throw createError({ statusCode: 404, message: errorMessage('media.asset_not_found') })

  return withMediaUrls(ctx.projectId, asset)
})
