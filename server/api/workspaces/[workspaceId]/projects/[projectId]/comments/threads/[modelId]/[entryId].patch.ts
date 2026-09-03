/**
 * Open or close one entry's thread. A closed thread still renders its
 * comments; the public submit endpoint refuses new ones.
 * Workspace owners/admins only.
 *
 * PATCH /api/workspaces/{workspaceId}/projects/{projectId}/comments/threads/{modelId}/{entryId}
 * body { closed: boolean, locale?: string }
 */

import { normalizeLocaleParam } from '~~/server/utils/comment-public-context'
import { requireCommentAccess } from '~~/server/utils/comment-moderation'

export default defineEventHandler(async (event) => {
  const ctx = await requireCommentAccess(event, 'moderate')
  const modelId = getRouterParam(event, 'modelId')
  const entryId = getRouterParam(event, 'entryId')
  if (!modelId || !entryId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  const body = await readBody<{ closed?: unknown, locale?: unknown }>(event)
  if (typeof body?.closed !== 'boolean')
    throw createError({ statusCode: 400, message: errorMessage('validation.data_required') })

  const key = { model_id: modelId, entry_id: entryId, locale: normalizeLocaleParam(body.locale) }
  const thread = await useDatabaseProvider().setCommentThreadClosed(ctx.projectId, ctx.workspaceId, key, body.closed, ctx.userId)

  return { ...key, closed: Boolean(thread.closed_at), closedAt: thread.closed_at ?? null }
})
