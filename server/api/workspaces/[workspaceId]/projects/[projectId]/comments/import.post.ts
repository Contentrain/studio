/**
 * WordPress comment import — accepts a `CommentsExport`
 * (`contentrain-comments@1`, `@contentrain/types`; produced by
 * `@contentrain/wp-import` / `npx contentrain import …`) and lands it in
 * this project's comments.
 *
 * Workspace owners/admins only; plan feature `comments.import`.
 *
 * Fidelity contract (S-08): zero record loss, zero parent loss.
 *   - every comment whose post maps to an entry is inserted with its source
 *     timestamp, status, type and parent link; depth is never clamped;
 *   - a comment whose post has NO entry mapping is reported (`unmapped`),
 *     never silently skipped; the caller fixes the export and re-sends;
 *   - re-sending is safe: rows are keyed on the source id, and a parent that
 *     arrives in a later chunk is linked to children imported earlier.
 *
 * Up to 5 000 comments per request; larger exports are sent in chunks (the
 * Comments Settings upload does this automatically).
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/comments/import
 * body: CommentsExport  (optional query ?locale= default locale for entry refs without one)
 */

import { normalizeLocaleParam } from '~~/server/utils/comment-public-context'
import { runCommentsImport } from '~~/server/utils/comment-import'
import { requireCommentAccess } from '~~/server/utils/comment-moderation'

export default defineEventHandler(async (event) => {
  const ctx = await requireCommentAccess(event, 'moderate')
  if (!hasFeature(ctx.plan, 'comments.import'))
    throw createError({ statusCode: 403, message: errorMessage('comments.upgrade') })

  const payload = await readBody<unknown>(event)
  const defaultLocale = normalizeLocaleParam(getQuery(event).locale)

  return runCommentsImport(ctx.projectId, ctx.workspaceId, payload, defaultLocale)
})
