// Explicit relative imports — integration-test harness bypasses Nuxt
// auto-imports (see workspaces/.../media/index.post.ts for rationale).
import { resolveMediaApiContext } from '../../../../../utils/media-api'
import { withMediaUrls } from '../../../../../utils/media-url'

/**
 * List media assets for a project.
 *
 * Public media API — Bearer `cdn_api_keys` key with `media:read`.
 * Supports search, tag filter, content-type filter, and pagination.
 */
export default defineEventHandler(async (event) => {
  const ctx = await resolveMediaApiContext(event, {
    scope: 'media:read',
    feature: 'media.library',
    upgradeKey: 'media.library_upgrade',
  })

  const query = getQuery(event) as {
    search?: string
    tags?: string
    type?: string
    limit?: string
    page?: string
    sort?: 'newest' | 'oldest' | 'name' | 'size'
  }

  const result = await ctx.media.listAssets(ctx.projectId, {
    search: query.search,
    tags: query.tags ? query.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
    contentType: query.type,
    limit: query.limit ? Math.min(Number(query.limit), 100) : 50,
    page: query.page ? Math.max(1, Number(query.page)) : undefined,
    sort: query.sort,
  })

  return {
    assets: result.assets.map(asset => withMediaUrls(ctx.projectId, asset)),
    total: result.total,
  }
})
