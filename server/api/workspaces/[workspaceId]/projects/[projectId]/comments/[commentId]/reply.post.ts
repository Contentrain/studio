/**
 * Moderator reply — a workspace owner/admin answers a comment from Studio.
 * The reply is published immediately (`approved`, `source = 'studio'`),
 * authored by the member's profile, and nested under the target comment.
 * Replying to a pending comment approves it first: an answer implies the
 * question is fit to show.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/comments/{commentId}/reply
 * body { body: string }
 */

import { notifyCommentApproved, requireCommentAccess, requireOwnedComment } from '~~/server/utils/comment-moderation'
import { sanitizeString } from '~~/server/utils/sanitize-input'

export default defineEventHandler(async (event) => {
  const ctx = await requireCommentAccess(event, 'moderate')
  const parent = await requireOwnedComment(ctx, getRouterParam(event, 'commentId'))

  const body = await readBody<{ body?: unknown }>(event)
  const text = typeof body?.body === 'string' ? sanitizeString(body.body).trim() : ''
  if (!text)
    throw createError({ statusCode: 400, message: errorMessage('comments.reply_body_required') })
  if (text.length > 20000)
    throw createError({ statusCode: 400, message: errorMessage('comments.body_too_long') })

  const db = useDatabaseProvider()

  if (parent.status !== 'approved') {
    const approved = await db.updateCommentStatus(parent.id as string, 'approved', ctx.userId)
    notifyCommentApproved(ctx, approved, 'api')
  }

  const profile = await db.getProfile(ctx.accessToken, ctx.userId).catch(() => null)
  const emailPrefix = typeof profile?.email === 'string' ? profile.email.split('@')[0] : ''
  const authorName = String(profile?.display_name || emailPrefix || 'Moderator').slice(0, 120)

  const reply = await db.createComment({
    project_id: ctx.projectId,
    workspace_id: ctx.workspaceId,
    model_id: parent.model_id as string,
    entry_id: parent.entry_id as string,
    locale: parent.locale as string,
    parent_id: parent.id as string,
    author_name: authorName,
    author_email: typeof profile?.email === 'string' ? profile.email : null,
    author_user_id: ctx.userId,
    body: text,
    status: 'approved',
    source: 'studio',
  })

  notifyCommentApproved(ctx, reply, 'api')

  return reply
})
