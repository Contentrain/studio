// Explicit relative imports — see index.get.ts.
import { resolveMediaApiContext } from '../../../../../utils/media-api'
import { withMediaUrls } from '../../../../../utils/media-url'

/**
 * Update media asset metadata (alt text, tags, focal point).
 * Public media API — `media:write`.
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

  const body = await readBody<{ alt?: string, tags?: string[], focalPoint?: { x: number, y: number } }>(event)

  const updated = await ctx.media.updateMetadata(assetId, {
    alt: body.alt,
    tags: body.tags,
    focalPoint: body.focalPoint,
  })

  return withMediaUrls(ctx.projectId, updated)
})
