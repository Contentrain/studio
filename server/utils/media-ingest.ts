/**
 * Media ingestion helpers shared by the session media routes, the public
 * media API (Bearer key), and the chat agent's media tools.
 *
 * Centralising the remote-fetch path keeps one SSRF-hardened, MIME- and
 * size-validated implementation instead of three drifting copies.
 */

import { isAllowedMimeType } from './media-variants'
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
