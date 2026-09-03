/**
 * WordPress comment import — accepts a `CommentsExport`
 * (`contentrain-comments@1`, `@contentrain/types`; produced by
 * `@contentrain/wp-import` / `contentrain import wordpress`) and lands it in
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
 * Up to 5 000 comments per request; larger exports are sent in chunks.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/comments/import
 * body: CommentsExport  (optional query ?locale= default locale for entry refs without one)
 */

import type { CommentsExport } from '@contentrain/types'
import { normalizeLocaleParam } from '~~/server/utils/comment-public-context'
import { requireCommentAccess } from '~~/server/utils/comment-moderation'
import { mapCommentsExport, validateCommentsExport } from '~~/server/utils/comment-thread'

export const IMPORT_MAX_COMMENTS = 5000

export default defineEventHandler(async (event) => {
  const ctx = await requireCommentAccess(event, 'moderate')
  if (!hasFeature(ctx.plan, 'comments.import'))
    throw createError({ statusCode: 403, message: errorMessage('comments.upgrade') })

  const payload = await readBody<unknown>(event)
  const invalid = validateCommentsExport(payload, IMPORT_MAX_COMMENTS)
  if (invalid) {
    const key = invalid.code === 'unsupported_format'
      ? 'comments.import_unsupported_format'
      : invalid.code === 'too_many_comments'
        ? 'comments.import_too_many'
        : invalid.code === 'invalid_entries'
          ? 'comments.import_invalid_entries'
          : 'comments.import_invalid'
    throw createError({ statusCode: 400, message: errorMessage(key, { detail: invalid.detail ?? '' }) })
  }

  const defaultLocale = normalizeLocaleParam(getQuery(event).locale)
  const mapped = mapCommentsExport(payload as CommentsExport, defaultLocale)

  const result = mapped.rows.length > 0 || mapped.threadsClosed.length > 0
    ? await useDatabaseProvider().importComments(ctx.projectId, ctx.workspaceId, {
        comments: mapped.rows,
        threads_closed: mapped.threadsClosed,
      })
    : { inserted: 0, skippedExisting: 0, orphanCount: 0, orphanParents: [], maxDepth: 0, threadsClosed: 0 }

  return {
    received: (payload as CommentsExport).comments.length,
    mapped: mapped.rows.length,
    inserted: result.inserted,
    skippedExisting: result.skippedExisting,
    unmapped: mapped.unmapped,
    orphanCount: result.orphanCount,
    orphanParents: result.orphanParents,
    maxDepth: result.maxDepth,
    threadsClosed: result.threadsClosed,
    datesDefaulted: mapped.datesDefaulted,
  }
})
