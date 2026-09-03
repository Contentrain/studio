/**
 * Pure comment helpers — no I/O, unit-tested in isolation:
 *
 *   - public shape (`toPublicComment`): what the read endpoint exposes.
 *     Email, IP, user agent and referrer never leave the server.
 *   - tree assembly (`buildCommentTree`): a page of roots + their approved
 *     replies → nested threads. A reply whose parent is not in the approved
 *     set is dropped, so moderating a comment out also hides its branch.
 *   - WordPress import mapping (`mapCommentsExport`): `CommentsExport`
 *     (`@contentrain/types`, produced by `@contentrain/wp-import`) → rows for
 *     `DatabaseProvider.importComments`. Nothing is dropped silently: a
 *     comment whose post has no entry mapping is reported, not skipped.
 */

import type { CommentsExport, RawComment } from '@contentrain/types'
import { COMMENTS_EXPORT_FORMAT } from '@contentrain/types'
import type { CommentImportRow, CommentStatus, CommentThreadKey, CommentType, DatabaseRow } from '~~/server/providers/database'
import { htmlToPlainText, sanitizeString } from './sanitize-input'

// ─── Public shape ───

export interface PublicComment {
  id: string
  parentId: string | null
  depth: number
  author: {
    name: string
    url: string | null
    /** Written from Studio by a workspace member. */
    isModerator: boolean
  }
  body: string
  type: CommentType
  createdAt: string
  replies: PublicComment[]
}

export function toPublicComment(row: DatabaseRow): PublicComment {
  return {
    id: String(row.id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    depth: Number(row.depth ?? 0),
    author: {
      name: String(row.author_name ?? ''),
      url: row.author_url ? String(row.author_url) : null,
      isModerator: row.source === 'studio' || Boolean(row.author_user_id),
    },
    body: String(row.body ?? ''),
    type: (row.type as CommentType) ?? 'comment',
    createdAt: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at as string | number | Date).toISOString(),
    replies: [],
  }
}

/**
 * Roots keep the order they were fetched in (the page's sort); replies are
 * attached in `created_at` order. Returns the roots with nested `replies`
 * and whether any reply had to be dropped for lack of a visible parent.
 */
export function buildCommentTree(roots: DatabaseRow[], replies: DatabaseRow[]): { threads: PublicComment[], dropped: number } {
  const nodes = new Map<string, PublicComment>()
  const threads = roots.map((row) => {
    const node = toPublicComment(row)
    nodes.set(node.id, node)
    return node
  })

  const sortedReplies = [...replies].sort((a, b) => {
    const da = Date.parse(String(a.created_at))
    const db = Date.parse(String(b.created_at))
    if (da !== db) return da - db
    return String(a.id).localeCompare(String(b.id))
  })

  let dropped = 0
  for (const row of sortedReplies) {
    const node = toPublicComment(row)
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (!parent) {
      dropped++
      continue
    }
    parent.replies.push(node)
    nodes.set(node.id, node)
  }

  return { threads, dropped }
}

// ─── WordPress import mapping ───

/** WordPress `comment_approved` → Studio status. Unknown values stay pending (never dropped). */
export function mapWordPressStatus(approved: string | undefined | null): CommentStatus {
  switch (approved) {
    case '1':
    case 'approve':
    case 'approved':
      return 'approved'
    case 'spam':
      return 'spam'
    case 'trash':
      return 'rejected'
    default:
      return 'pending'
  }
}

export function normalizeCommentType(type: string | undefined | null): CommentType {
  if (type === 'pingback' || type === 'trackback') return type
  return 'comment'
}

export interface MappedCommentsExport {
  rows: CommentImportRow[]
  threadsClosed: CommentThreadKey[]
  /** Comments whose post has no entry in the export's `entries` map. */
  unmapped: Array<{ comment_id: number, post: number }>
  /** Comments whose date could not be parsed — imported with the export's `generated_at`. */
  datesDefaulted: number
}

export interface CommentsExportValidationError {
  code: 'invalid_payload' | 'unsupported_format' | 'too_many_comments' | 'invalid_entries'
  detail?: string
}

/** Shape check before any mapping — the endpoint turns this into a 400. */
export function validateCommentsExport(input: unknown, maxComments: number): CommentsExportValidationError | null {
  if (!input || typeof input !== 'object') return { code: 'invalid_payload' }
  const exp = input as Partial<CommentsExport>
  if (exp.format !== COMMENTS_EXPORT_FORMAT)
    return { code: 'unsupported_format', detail: String(exp.format ?? 'missing') }
  if (!exp.entries || typeof exp.entries !== 'object' || Array.isArray(exp.entries))
    return { code: 'invalid_entries' }
  if (!Array.isArray(exp.comments)) return { code: 'invalid_payload', detail: 'comments must be an array' }
  if (exp.comments.length > maxComments)
    return { code: 'too_many_comments', detail: String(exp.comments.length) }
  for (const [post, ref] of Object.entries(exp.entries)) {
    if (!ref || typeof ref !== 'object' || typeof ref.model_id !== 'string' || typeof ref.entry_id !== 'string')
      return { code: 'invalid_entries', detail: post }
  }
  return null
}

function parseSourceDate(comment: RawComment): string | null {
  for (const candidate of [comment.date, comment.date_gmt]) {
    if (!candidate) continue
    const ms = Date.parse(candidate)
    if (!Number.isNaN(ms)) return new Date(ms).toISOString()
  }
  return null
}

function clean(value: string | null | undefined, max: number): string | null {
  if (!value) return null
  const s = sanitizeString(String(value)).trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max) : s
}

/** Author URLs must be absolute http(s); anything else is dropped, never rewritten. */
function cleanUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(String(value).trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString().slice(0, 2048)
  }
  catch {
    return null
  }
}

/**
 * `CommentsExport` → import rows. Targets come from `entries`
 * (WordPress post id → entry); parents travel as source ids and are linked
 * inside `import_comments`. The export's default locale applies when an
 * entry ref carries none.
 */
export function mapCommentsExport(exp: CommentsExport, defaultLocale = 'en'): MappedCommentsExport {
  const rows: CommentImportRow[] = []
  const unmapped: Array<{ comment_id: number, post: number }> = []
  let datesDefaulted = 0
  const fallbackDate = (() => {
    const ms = Date.parse(exp.generated_at ?? '')
    return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString()
  })()

  const targetFor = (post: number): CommentThreadKey | null => {
    const ref = exp.entries[String(post)]
    if (!ref) return null
    return { model_id: ref.model_id, entry_id: ref.entry_id, locale: ref.locale ?? defaultLocale }
  }

  for (const comment of exp.comments) {
    const target = targetFor(comment.post)
    if (!target) {
      unmapped.push({ comment_id: comment.id, post: comment.post })
      continue
    }

    let createdAt = parseSourceDate(comment)
    if (!createdAt) {
      createdAt = fallbackDate
      datesDefaulted++
    }

    const body = htmlToPlainText(String(comment.content ?? ''))

    rows.push({
      source_id: String(comment.id),
      source_parent_id: comment.parent ? String(comment.parent) : null,
      model_id: target.model_id,
      entry_id: target.entry_id,
      locale: target.locale,
      author_name: clean(comment.author, 120) ?? 'Anonymous',
      author_email: clean(comment.email, 254),
      author_url: cleanUrl(comment.url),
      // A comment is never dropped for an empty body; the check constraint needs one character.
      body: body || '…',
      status: mapWordPressStatus(comment.approved),
      type: normalizeCommentType(comment.type),
      created_at: createdAt,
    })
  }

  const threadsClosed: CommentThreadKey[] = []
  const seen = new Set<string>()
  for (const post of exp.threads_closed ?? []) {
    const target = targetFor(post)
    if (!target) continue
    const k = `${target.model_id} ${target.entry_id} ${target.locale}`
    if (seen.has(k)) continue
    seen.add(k)
    threadsClosed.push(target)
  }

  return { rows, threadsClosed, unmapped, datesDefaulted }
}
