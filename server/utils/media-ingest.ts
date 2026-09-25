/**
 * Media ingestion helpers shared by the session media routes, the public
 * media API (Bearer key), and the chat agent's media tools.
 *
 * Centralising the remote-fetch path keeps one SSRF-hardened, MIME- and
 * size-validated implementation instead of three drifting copies.
 */

import { fileTypeFromBuffer } from 'file-type'
import { isAllowedMimeType } from './media-variants'
import { sanitizeSvg } from './svg-sanitize'
import { isAllowedWebhookUrl } from './webhook-engine'

export interface RemoteMedia {
  buffer: Buffer
  filename: string
  contentType: string
}

/**
 * Fetch a media file from an external URL for ingestion.
 *
 * Hardened against SSRF (`isAllowedWebhookUrl` blocks internal/private/
 * loopback/link-local targets), enforces the MIME whitelist and the
 * per-plan size cap, and normalises the filename. Throws `createError`
 * with a stable shape so every call site surfaces consistent errors.
 */
export async function fetchRemoteMedia(input: { url: string, maxBytes: number }): Promise<RemoteMedia> {
  const url = input.url.trim()
  if (!url)
    throw createError({ statusCode: 400, message: errorMessage('media.url_required') })

  if (!isAllowedWebhookUrl(url))
    throw createError({ statusCode: 400, message: errorMessage('media.url_blocked') })

  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'Contentrain-Studio/1.0' },
      signal: AbortSignal.timeout(30_000),
    })
  }
  catch {
    throw createError({ statusCode: 400, message: errorMessage('media.url_fetch_failed') })
  }

  if (!response.ok)
    throw createError({ statusCode: 400, message: errorMessage('media.url_bad_response', { status: response.status }) })

  const contentType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim()
  if (!isAllowedMimeType(contentType))
    throw createError({ statusCode: 400, message: errorMessage('media.file_type_not_allowed', { type: contentType }) })

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > input.maxBytes)
    throw createError({ statusCode: 400, message: errorMessage('media.file_too_large', { limit: Math.round(input.maxBytes / (1024 * 1024)) }) })

  const filename = new URL(url).pathname.split('/').pop() || 'imported-file'
  return { buffer, filename, contentType }
}

// ─── Media from the project's own repository (a migration's committed files) ───

/** Past this many pixels a raster is refused before decoding — the optimizer's own ceiling (ee/media). */
export const REPO_MEDIA_MAX_PIXELS = 100_000_000

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
}

/** A storage-safe file name from a repository path: its base name, plain characters, the extension its content has. */
export function normalizeRepoFilename(repoPath: string, mime: string): string {
  const base = repoPath.split('/').pop() ?? ''
  const stem = base.replace(/\.[^.]*$/, '').normalize('NFKC')
    .replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 120)
  return `${stem || 'migrated-file'}.${EXT_BY_MIME[mime] ?? 'bin'}`
}

export interface RepoMediaInput {
  buffer: Buffer
  repoPath: string
  /** The MIME the manifest declares — checked against the bytes, never trusted alone. */
  declaredMime?: string
  maxBytes: number
  /** Dimensions the manifest declares, when it does. */
  width?: number
  height?: number
}

/**
 * Check a file read from the project's repository before it becomes an asset.
 *
 * The repository is the customer's: its bytes are checked like any upload,
 * not trusted because Studio read them itself. The type is what the bytes are
 * (magic numbers via `file-type`; an SVG by its markup), and must match the
 * declared type and the upload whitelist; an SVG is sanitized with Migrate's
 * rules and refused if it cannot be made safe; the size is the plan's cap; the name
 * is rebuilt from the path; a raster declaring more than
 * `REPO_MEDIA_MAX_PIXELS` is refused before anything decodes it (the
 * optimizer enforces the same ceiling on decode). No network is involved, so
 * there is no SSRF surface here — `fetchRemoteMedia` stays the URL path.
 */
export async function inspectRepoMedia(input: RepoMediaInput): Promise<RemoteMedia> {
  if (input.buffer.length === 0)
    throw createError({ statusCode: 400, message: errorMessage('media.no_file_provided') })
  if (input.buffer.length > input.maxBytes)
    throw createError({ statusCode: 400, message: errorMessage('media.file_too_large', { limit: Math.round(input.maxBytes / (1024 * 1024)) }) })

  const sniffed = (await fileTypeFromBuffer(input.buffer).catch(() => undefined))?.mime
  let contentType: string
  if (sniffed) {
    contentType = sniffed
  }
  else {
    // No magic number: only an SVG (text) is acceptable, and only if it is one.
    const head = input.buffer.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart()
    if (!/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head))
      throw createError({ statusCode: 400, message: errorMessage('media.file_type_not_allowed', { type: input.declaredMime ?? 'unknown' }) })
    contentType = 'image/svg+xml'
  }

  if (!isAllowedMimeType(contentType))
    throw createError({ statusCode: 400, message: errorMessage('media.file_type_not_allowed', { type: contentType }) })
  if (input.declaredMime && input.declaredMime !== contentType)
    throw createError({ statusCode: 400, message: errorMessage('media.content_mismatch', { declared: input.declaredMime, actual: contentType }) })

  let buffer = input.buffer
  if (contentType === 'image/svg+xml') {
    // Sanitized again with Migrate's own rules (`svg-sanitize.ts`); one that cannot be made safe is refused.
    const clean = sanitizeSvg(input.buffer)
    if (!clean.ok)
      throw createError({ statusCode: 400, message: errorMessage('media.svg_unsafe', { reason: clean.reason }) })
    buffer = clean.bytes
  }
  else if (contentType.startsWith('image/') && input.width && input.height && input.width * input.height > REPO_MEDIA_MAX_PIXELS) {
    throw createError({ statusCode: 400, message: errorMessage('media.image_too_many_pixels', { limit: REPO_MEDIA_MAX_PIXELS / 1_000_000 }) })
  }

  return { buffer, filename: normalizeRepoFilename(input.repoPath, contentType), contentType }
}
