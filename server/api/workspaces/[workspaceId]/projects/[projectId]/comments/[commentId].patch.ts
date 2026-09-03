/**
 * Moderate one comment: approve, reject, mark as spam, or send back to pending.
 * Workspace owners/admins only.
 *
 * PATCH /api/workspaces/{workspaceId}/projects/{projectId}/comments/{commentId}
 * body { status: 'approved' | 'rejected' | 'spam' | 'pending' }
 */

import { isModerationStatus, notifyCommentApproved, requireCommentAccess, requireOwnedComment } from '~~/server/utils/comment-moderation'

export default defineEventHandler(async (event) => {
  const ctx = await requireCommentAccess(event, 'moderate')
  const existing = await requireOwnedComment(ctx, getRouterParam(event, 'commentId'))

  const body = await readBody<{ status?: unknown }>(event)
  if (!isModerationStatus(body?.status))
    throw createError({ statusCode: 400, message: errorMessage('comments.invalid_status') })

  const updated = await useDatabaseProvider().updateCommentStatus(existing.id as string, body.status, ctx.userId)

  if (body.status === 'approved' && existing.status !== 'approved')
    notifyCommentApproved(ctx, updated, 'api')

  return updated
})
