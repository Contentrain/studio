/**
 * Shared authorization + lookups for the comment moderation routes
 * (`/api/workspaces/{ws}/projects/{p}/comments...`).
 *
 * Read access: every workspace role, members only with a project assignment
 * (same rule as form submissions). Moderation (status, delete, reply, close,
 * import): workspace owner/admin. Both gated on `comments.enabled`.
 */

import type { H3Event } from 'h3'
import type { DatabaseRow } from '~~/server/providers/database'

export interface CommentModerationContext {
  workspaceId: string
  projectId: string
  userId: string
  accessToken: string
  role: string
  plan: ReturnType<typeof getWorkspacePlan>
}

export async function requireCommentAccess(event: H3Event, mode: 'read' | 'moderate'): Promise<CommentModerationContext> {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  const db = useDatabaseProvider()
  const roles = mode === 'moderate' ? ['owner', 'admin'] : ['owner', 'admin', 'member']
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, roles)

  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  if (role === 'member') {
    const pm = await db.getProjectMember(projectId, session.user.id)
    if (!pm) throw createError({ statusCode: 403, message: errorMessage('project.access_denied') })
  }

  const ws = await db.getWorkspaceById(workspaceId, 'plan')
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(ws ?? {})
  if (!hasFeature(plan, 'comments.enabled'))
    throw createError({ statusCode: 403, message: errorMessage('comments.upgrade') })

  return { workspaceId, projectId, userId: session.user.id, accessToken: session.accessToken, role, plan }
}

/** A comment that exists and belongs to this workspace + project, else 404. */
export async function requireOwnedComment(ctx: CommentModerationContext, commentId: string | undefined): Promise<DatabaseRow> {
  if (!commentId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })
  const existing = await useDatabaseProvider().getComment(commentId)
  if (!existing || existing.workspace_id !== ctx.workspaceId || existing.project_id !== ctx.projectId)
    throw createError({ statusCode: 404, message: errorMessage('comments.comment_not_found') })
  return existing
}

/** Fire-and-forget `comment.approved` when the plan grants comment webhooks. */
export function notifyCommentApproved(ctx: CommentModerationContext, comment: DatabaseRow, source: 'api' | 'conversation'): void {
  if (!hasFeature(ctx.plan, 'comments.webhook_notification')) return
  emitWebhookEvent(ctx.projectId, ctx.workspaceId, 'comment.approved', {
    commentId: comment.id,
    modelId: comment.model_id,
    entryId: comment.entry_id,
    locale: comment.locale,
    source,
  }).catch(() => {})
}

export const MODERATION_STATUSES = ['pending', 'approved', 'rejected', 'spam'] as const
export type ModerationStatus = (typeof MODERATION_STATUSES)[number]

export function isModerationStatus(value: unknown): value is ModerationStatus {
  return typeof value === 'string' && (MODERATION_STATUSES as readonly string[]).includes(value)
}
