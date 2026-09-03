/**
 * Bulk moderation: approve, reject, spam, pending, or delete up to 50 comments.
 * Workspace owners/admins only. Deletes are sequential with an explicit audit
 * row each (a POST never passes the DELETE audit middleware).
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/comments/bulk
 * body { action: 'approve' | 'reject' | 'spam' | 'pending' | 'delete', commentIds: string[] }
 */

import type { CommentStatus } from '~~/server/providers/database'
import { notifyCommentApproved, requireCommentAccess } from '~~/server/utils/comment-moderation'

const ACTION_STATUS: Record<string, CommentStatus> = {
  approve: 'approved',
  reject: 'rejected',
  spam: 'spam',
  pending: 'pending',
}

export default defineEventHandler(async (event) => {
  const ctx = await requireCommentAccess(event, 'moderate')
  const db = useDatabaseProvider()

  const body = await readBody<{ action?: string, commentIds?: unknown }>(event)
  const action = body?.action ?? ''
  if (action !== 'delete' && !(action in ACTION_STATUS))
    throw createError({ statusCode: 400, message: errorMessage('comments.invalid_action') })

  const ids = Array.isArray(body?.commentIds) ? body.commentIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
  if (ids.length === 0)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })
  if (ids.length > 50)
    throw createError({ statusCode: 400, message: errorMessage('comments.bulk_limit') })

  if (action === 'delete') {
    const results: { id: string, success: boolean, error?: string }[] = []
    const sourceIp = getRequestIP(event, { xForwardedFor: true }) ?? null
    const userAgent = getHeader(event, 'user-agent') ?? null

    for (const commentId of ids) {
      try {
        const existing = await db.getComment(commentId)
        if (!existing || existing.workspace_id !== ctx.workspaceId || existing.project_id !== ctx.projectId) {
          results.push({ id: commentId, success: false, error: 'Not found' })
          continue
        }
        await db.deleteComment(commentId)
        await db.createAuditLog({
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId,
          action: 'delete_comment',
          tableName: 'comments',
          recordId: commentId,
          recordSnapshot: existing as Record<string, unknown>,
          sourceIp,
          userAgent,
        }).catch(() => {})
        results.push({ id: commentId, success: true })
      }
      catch (error) {
        results.push({ id: commentId, success: false, error: error instanceof Error ? error.message : 'Unknown error' })
      }
    }
    return { action, results, succeeded: results.filter(r => r.success).length }
  }

  const status = ACTION_STATUS[action]!
  const updated = await db.bulkUpdateComments(ids, status, ctx.userId, { workspaceId: ctx.workspaceId, projectId: ctx.projectId })

  if (status === 'approved' && updated > 0 && hasFeature(ctx.plan, 'comments.webhook_notification')) {
    // One event per approved comment keeps the payload shape identical to the single route.
    for (const id of ids) {
      const row = await db.getComment(id)
      if (row && row.status === 'approved' && row.workspace_id === ctx.workspaceId)
        notifyCommentApproved(ctx, row, 'api')
    }
  }

  return { action, updated }
})
