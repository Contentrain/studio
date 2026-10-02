/**
 * A Migrate delivery's comments export, taken while the claim is made (İP-2c).
 *
 * The claim token carries `comments_export {url, token, expires_at, comments}`:
 * Migrate's fixed export address and a bearer token for it. The bearer is
 * never stored and never logged, so the export is fetched now — the project it
 * belongs to does not exist yet — and its payload is held on the grant
 * (migration 040) until the project imports it (`import-comments`).
 *
 * - The address is fetched only when its origin is on `NUXT_MIGRATE_ORIGINS`
 *   and its path is Migrate's export path. The claim naming a host is not a
 *   reason to trust it; an empty list fetches nothing.
 * - The token travels only in `Authorization`. No error, log line or row
 *   carries it.
 * - One attempt is short (10 s) and capped at the import's size limit. A
 *   refusal (401/403/404), a 5xx or a dropped connection is retried once.
 * - Whatever goes wrong — a claim whose export had the wrong shape (dropped
 *   by the contract, `warnings`), a fetch that failed twice, a payload that is
 *   not `contentrain-comments@1` — the grant's export is `unavailable` and the
 *   project's comments settings offer the file upload. The claim never fails
 *   for it, and never waits for it.
 */
import type { MigrateStudioCommentsExport } from '@contentrain/types'
import { validateCommentsExport } from './comment-thread'
import { EXPORT_MAX_BYTES } from './migration-handoff'

/** Migrate's export route (`apps/web/server/api/exports/comments.get.ts`). */
export const MIGRATE_COMMENTS_EXPORT_PATH = '/api/exports/comments'
export const COMMENTS_EXPORT_ATTEMPT_MS = 10_000
/** The grant window (XS-1 §6): an export dropped from the claim keeps its row this long. */
const GRANT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export type CommentsExportFailure = 'not_allowed' | 'refused' | 'bad_status' | 'too_large' | 'timeout' | 'network' | 'invalid'

export class CommentsExportFetchError extends Error {
  constructor(readonly code: CommentsExportFailure, readonly status?: number) {
    // The message names the failure, never the token.
    super(`comments export: ${code}${status ? ` (${status})` : ''}`)
  }

  get retryable(): boolean {
    return this.code === 'refused' || this.code === 'timeout' || this.code === 'network' || (this.code === 'bad_status' && (this.status ?? 0) >= 500)
  }
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * The Migrate origins Studio fetches an export from (`NUXT_MIGRATE_ORIGINS`,
 * comma-separated). `https:` only, `http:` for localhost; anything else in the
 * list is ignored. Empty — the default — fetches nothing.
 */
export function migrateExportOrigins(raw?: string): string[] {
  const value = raw ?? (useRuntimeConfig() as unknown as { migrate?: { origins?: string } }).migrate?.origins ?? ''
  const origins: string[] = []
  for (const part of String(value).split(',')) {
    const text = part.trim()
    if (!text) continue
    try {
      const url = new URL(text)
      if (url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url.hostname))) origins.push(url.origin)
    }
    catch {
      // not a URL: ignored
    }
  }
  return origins
}

/** Whether `rawUrl` is Migrate's export address on an allowed origin: no userinfo, query or fragment. */
export function isAllowedExportUrl(rawUrl: string, origins: string[]): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  }
  catch {
    return false
  }
  if (url.username || url.password || url.search || url.hash) return false
  if (url.pathname !== MIGRATE_COMMENTS_EXPORT_PATH) return false
  return origins.includes(url.origin)
}

export interface CommentsExportFetchOptions {
  origins: string[]
  fetchImpl?: typeof fetch
  attemptMs?: number
  maxBytes?: number
  /** Pause before the one retry. */
  retryDelayMs?: number
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new CommentsExportFetchError('too_large')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new CommentsExportFetchError('too_large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchOnce(pointer: MigrateStudioCommentsExport, options: CommentsExportFetchOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(pointer.url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${pointer.token}`, 'Accept': 'application/json', 'User-Agent': 'Contentrain-Studio/1.0 (comments export)' },
      // A redirect would carry the bearer to an address nobody checked.
      redirect: 'manual',
      signal: AbortSignal.timeout(options.attemptMs ?? COMMENTS_EXPORT_ATTEMPT_MS),
    })
  }
  catch (error) {
    const name = (error as { name?: string }).name
    throw new CommentsExportFetchError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network')
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await response.body?.cancel().catch(() => {})
    throw new CommentsExportFetchError('refused', response.status)
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {})
    throw new CommentsExportFetchError('bad_status', response.status)
  }
  let text: string
  try {
    text = await readCapped(response, options.maxBytes ?? EXPORT_MAX_BYTES)
  }
  catch (error) {
    if (error instanceof CommentsExportFetchError) throw error
    const name = (error as { name?: string }).name
    throw new CommentsExportFetchError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network')
  }
  try {
    return JSON.parse(text)
  }
  catch {
    throw new CommentsExportFetchError('invalid')
  }
}

/**
 * Fetch and check the export the claim points at: at most two attempts, the
 * second only after a retryable failure. Throws `CommentsExportFetchError`.
 */
export async function fetchClaimCommentsExport(pointer: MigrateStudioCommentsExport, options: CommentsExportFetchOptions): Promise<{ payload: unknown, comments: number }> {
  if (!isAllowedExportUrl(pointer.url, options.origins)) throw new CommentsExportFetchError('not_allowed')
  let payload: unknown
  try {
    payload = await fetchOnce(pointer, options)
  }
  catch (error) {
    if (!(error instanceof CommentsExportFetchError) || !error.retryable) throw error
    await new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? 1000))
    payload = await fetchOnce(pointer, options)
  }
  if (validateCommentsExport(payload, Number.MAX_SAFE_INTEGER)) throw new CommentsExportFetchError('invalid')
  return { payload, comments: (payload as { comments: unknown[] }).comments.length }
}

export interface CaptureCommentsExportInput {
  grantId: string
  /** The claim's export, after the contract check; absent when there was none or it was dropped. */
  pointer?: MigrateStudioCommentsExport
  /** The contract's `warnings` — `comments_export.*` when an export was dropped. */
  warnings?: string[]
}

/**
 * Take the claim's comments export onto the grant. Never throws: every
 * failure lands as `unavailable` (and is logged without the token). A grant
 * whose export is already held or imported is left as it is.
 */
export async function captureClaimCommentsExport(input: CaptureCommentsExportInput, options: Partial<CommentsExportFetchOptions> = {}): Promise<'ready' | 'unavailable' | 'kept' | 'none'> {
  const dropped = (input.warnings ?? []).filter(w => w.startsWith('comments_export'))
  if (!input.pointer && dropped.length === 0) return 'none'
  const db = useDatabaseProvider()
  try {
    const existing = await db.getMigrateCommentsExportState(input.grantId)
    if (existing && (existing.status === 'ready' || existing.status === 'imported')) return 'kept'

    if (!input.pointer) {
      // Only the field names: a warning could quote a value.
      // eslint-disable-next-line no-console -- ops visibility; never the token
      console.warn(`[migrate-comments] grant=${input.grantId} export dropped from the claim: ${dropped.map(w => w.split(':')[0]).join(', ')}`)
      await db.saveMigrateCommentsExport(input.grantId, { status: 'unavailable', payload: null, comments: 0, expiresAt: new Date(Date.now() + GRANT_WINDOW_MS).toISOString() })
      return 'unavailable'
    }

    const expiresAt = new Date(input.pointer.expires_at * 1000).toISOString()
    try {
      const { payload, comments } = await fetchClaimCommentsExport(input.pointer, { ...options, origins: options.origins ?? migrateExportOrigins() })
      await db.saveMigrateCommentsExport(input.grantId, { status: 'ready', payload, comments, expiresAt })
      return 'ready'
    }
    catch (error) {
      const code = error instanceof CommentsExportFetchError ? error.message : 'comments export: failed'
      // eslint-disable-next-line no-console -- ops visibility; never the token
      console.warn(`[migrate-comments] grant=${input.grantId} ${code}; the file upload stays open`)
      await db.saveMigrateCommentsExport(input.grantId, { status: 'unavailable', payload: null, comments: input.pointer.comments, expiresAt })
      return 'unavailable'
    }
  }
  catch {
    // eslint-disable-next-line no-console -- ops visibility; never the token
    console.warn(`[migrate-comments] grant=${input.grantId} could not record the comments export`)
    return 'unavailable'
  }
}
