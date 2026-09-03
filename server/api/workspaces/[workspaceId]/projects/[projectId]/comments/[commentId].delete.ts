/**
 * Delete one comment (its replies go with it — FK cascade).
 * Workspace owners/admins only. The audit middleware snapshots the row first;
 * the DB trigger is the safety net.
 *
 * DELETE /api/workspaces/{workspaceId}/projects/{projectId}/comments/{commentId}
 */

import { requireCommentAccess, requireOwnedComment } from '~~/server/utils/comment-moderation'

export default defineEventHandler(async (event) => {
  const ctx = await requireCommentAccess(event, 'moderate')
  const existing = await requireOwnedComment(ctx, getRouterParam(event, 'commentId'))

  await useDatabaseProvider().deleteComment(existing.id as string)

  return { deleted: true }
})
