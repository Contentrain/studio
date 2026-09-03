/**
 * List a project's comments for moderation.
 * Filters: status, modelId, entryId, locale; pagination; sort.
 * Returns status counts alongside so the UI can render its tabs from one call.
 *
 * GET /api/workspaces/{workspaceId}/projects/{projectId}/comments
 */

import { isModerationStatus, requireCommentAccess } from '~~/server/utils/comment-moderation'

export default defineEventHandler(async (event) => {
  const ctx = await requireCommentAccess(event, 'read')
  const query = getQuery(event)

  const status = isModerationStatus(query.status) ? query.status : undefined
  const modelId = typeof query.modelId === 'string' && query.modelId ? query.modelId : undefined
  const entryId = typeof query.entryId === 'string' && query.entryId ? query.entryId : undefined
  const locale = typeof query.locale === 'string' && query.locale ? query.locale : undefined
  const page = Math.max(1, Number(query.page ?? 1) || 1)
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50) || 50))
  const sort = query.sort === 'oldest' ? 'oldest' : 'newest'

  const db = useDatabaseProvider()
  const [listing, counts] = await Promise.all([
    db.listComments(ctx.workspaceId, ctx.projectId, { status, modelId, entryId, locale, page, limit, sort }),
    db.countCommentsByStatus(ctx.projectId, modelId),
  ])

  // Moderators see everything except the raw client fingerprint fields the
  // public never sees either; email stays (it is what moderation is for).
  return {
    comments: listing.comments,
    total: listing.total,
    counts,
    page,
    limit,
  }
})
