/**
 * Shared core of the WordPress comment import — used by the upload route
 * (`comments/import.post.ts`) and by the migration handoff intake, which
 * finds the same `contentrain-comments@1` export inside
 * `contentrain-handoff.json` (inline or by URL).
 */

import type { CommentsExport, RawComment } from '@contentrain/types'
import { mapCommentsExport, validateCommentsExport } from './comment-thread'

export const IMPORT_MAX_COMMENTS = 5000

export interface CommentsImportReport {
  received: number
  mapped: number
  inserted: number
  skippedExisting: number
  unmapped: Array<{ comment_id: number, post: number }>
  orphanCount: number
  orphanParents: Array<{ source_id: string, source_parent_id: string }>
  maxDepth: number
  threadsClosed: number
  datesDefaulted: number
}

function importErrorKey(code: string): string {
  switch (code) {
    case 'unsupported_format': return 'comments.import_unsupported_format'
    case 'too_many_comments': return 'comments.import_too_many'
    case 'invalid_entries': return 'comments.import_invalid_entries'
    default: return 'comments.import_invalid'
  }
}

/**
 * Validate + map + land one export (≤ IMPORT_MAX_COMMENTS comments). Throws a
 * 400 `createError` for a malformed payload; everything else is reported,
 * never dropped (see `mapCommentsExport` / `import_comments`).
 */
export async function runCommentsImport(
  projectId: string,
  workspaceId: string,
  payload: unknown,
  defaultLocale: string,
): Promise<CommentsImportReport> {
  const invalid = validateCommentsExport(payload, IMPORT_MAX_COMMENTS)
  if (invalid)
    throw createError({ statusCode: 400, message: errorMessage(importErrorKey(invalid.code), { detail: invalid.detail ?? '' }) })

  const exp = payload as CommentsExport
  const mapped = mapCommentsExport(exp, defaultLocale)

  const result = mapped.rows.length > 0 || mapped.threadsClosed.length > 0
    ? await useDatabaseProvider().importComments(projectId, workspaceId, {
        comments: mapped.rows,
        threads_closed: mapped.threadsClosed,
      })
    : { inserted: 0, skippedExisting: 0, orphanCount: 0, orphanParents: [], maxDepth: 0, threadsClosed: 0 }

  return {
    received: exp.comments.length,
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
}

/**
 * Land an export of any size by chunking `comments` (the entries map travels
 * with every chunk). Idempotent rows + cross-chunk parent linking make the
 * split invisible to the result.
 */
export async function runCommentsImportChunked(
  projectId: string,
  workspaceId: string,
  exp: CommentsExport,
  defaultLocale: string,
): Promise<CommentsImportReport> {
  const total: CommentsImportReport = {
    received: 0, mapped: 0, inserted: 0, skippedExisting: 0, unmapped: [], orphanCount: 0, orphanParents: [], maxDepth: 0, threadsClosed: 0, datesDefaulted: 0,
  }
  const comments = Array.isArray(exp.comments) ? exp.comments : []
  const chunks: RawComment[][] = comments.length === 0 ? [[]] : []
  for (let offset = 0; offset < comments.length; offset += IMPORT_MAX_COMMENTS)
    chunks.push(comments.slice(offset, offset + IMPORT_MAX_COMMENTS))

  for (const [index, chunk] of chunks.entries()) {
    // threads_closed only needs to land once
    const part = await runCommentsImport(projectId, workspaceId, { ...exp, comments: chunk, threads_closed: index === 0 ? exp.threads_closed : [] }, defaultLocale)
    total.received += part.received
    total.mapped += part.mapped
    total.inserted += part.inserted
    total.skippedExisting += part.skippedExisting
    total.unmapped.push(...part.unmapped)
    total.orphanCount = part.orphanCount
    total.orphanParents = part.orphanParents
    total.maxDepth = Math.max(total.maxDepth, part.maxDepth)
    total.threadsClosed += part.threadsClosed
    total.datesDefaulted += part.datesDefaulted
  }
  return total
}
