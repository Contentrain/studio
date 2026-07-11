/**
 * Conversation attachment ingestion (core / AGPL).
 *
 * Turns a user-attached file or a pasted URL into self-contained
 * `AIContentBlock[]` the chat agent can consume. Design constraints
 * (see plan): EPHEMERAL — no new storage provider, no new billing line;
 * converted content rides the existing chat token metering. Per type:
 *
 *   - csv / txt / md / tsv / json  → text block (provenance-headed)
 *   - docx (Word)                  → text block (mammoth)
 *   - xlsx (Excel)                 → text block, Markdown tables (exceljs)
 *   - pdf                          → native `document` (base64) block
 *   - image (png/jpeg/gif/webp)    → image block:
 *       · CDN/media ON  → upload to the media library, reference by URL
 *       · CDN/media OFF → sharp-downscaled, size-capped base64 (fallback)
 *   - link (URL)                   → text block (HTML → text)
 *
 * Binaries are discarded after conversion (except the CDN image path,
 * which persists the asset in the media library by design). Per-input
 * failures return an `AttachmentRef` with `error` set rather than
 * throwing, so the endpoint can return mixed success/failure results.
 *
 * Sibling-util references use explicit imports (test-resolvable);
 * `errorMessage` / `createError` are Nuxt/h3 auto-import globals
 * (matching `media-ingest.ts`).
 */

import ExcelJS from 'exceljs'
import { fileTypeFromBuffer } from 'file-type'
import mammoth from 'mammoth'
import sharp from 'sharp'
import type { AIContentBlock, AIImageMediaType } from '../providers/ai'
import { publicMediaBase, toDeliveryUrl } from './media-url'
import { resolveVariantConfig } from './media-variants'
import { useMediaProvider } from './providers'
import { isAllowedWebhookUrl } from './webhook-engine'

/**
 * Where the user wants an attachment to go:
 * - `context`  → ephemeral input for the agent (never persisted). Default.
 * - `media`    → persisted as a managed media-library/CDN asset.
 *
 * Only the image branch acts on this — text/docs/links are inherently
 * `context`. Previously the image branch chose CDN-vs-ephemeral purely from
 * the plan, silently persisting images on media-enabled plans; routing it
 * through an explicit intent keeps the two purposes (and their billing /
 * persistence side effects) under the user's control.
 */
export type AttachmentIntent = 'context' | 'media'

/** What an ingested attachment contributes to the chat request. */
export interface AttachmentRef {
  /** Client/uuid id for dedupe + removal in the UI. */
  id: string
  source: 'upload' | 'link'
  filename: string
  mime: string
  kind: 'text' | 'document' | 'image'
  /** Where the attachment actually landed (set for the image branch). */
  destination?: AttachmentIntent
  /** Server-built content blocks. Empty when `error` is set. */
  blocks: AIContentBlock[]
  /** First chars of text, or the delivery URL for an image. */
  preview?: string
  bytes?: number
  /** True when converted text was truncated to the char cap. */
  truncated?: boolean
  /** Set when ingestion failed; `blocks` is then empty. */
  error?: string
}

export interface IngestFileInput {
  buffer: Buffer
  filename: string
  declaredMime: string
  projectId: string
  workspaceId: string
  userId: string
  plan: string
  /** Desired destination. Defaults to `context` (ephemeral). */
  intent?: AttachmentIntent
  /**
   * Whether the project serves CDN delivery (`projects.cdn_enabled`).
   * Media-intent images are refused without it: the upload itself would
   * succeed, but the delivery URL 403s for everyone — including the
   * model, which kills the whole chat turn (issue #137).
   */
  cdnEnabled?: boolean
}

/** Max converted text length (~25K tokens) before truncation. */
export const MAX_TEXT_CHARS = 100_000
/** Max base64-image raw bytes after optimization (keeps the chat body small). */
const MAX_BASE64_IMAGE_BYTES = 1_100_000
/** Max useful image edge for Claude vision; also the downscale target. */
const IMAGE_MAX_DIM = 1568
/**
 * PDF ceiling. Anthropic allows 32MB, but the block round-trips through
 * the chat JSON body (pre-upload → client → chat POST), so we cap lower
 * to keep that payload sane. Raise later if a server-side ephemeral
 * cache is added.
 */
const MAX_PDF_BYTES = 10 * 1024 * 1024
/** Max attachment inputs accepted per chat turn. */
export const MAX_ATTACHMENT_COUNT = 10
/** base64 string-length caps for client-supplied blocks (forge guard). */
const MAX_IMAGE_BASE64_CHARS = 2_200_000
const MAX_PDF_BASE64_CHARS = 14_500_000
/** Total serialized attachment-block budget per chat turn. */
const MAX_TOTAL_ATTACHMENT_CHARS = 18_000_000
/** Cap per-sheet rows in xlsx → markdown to avoid multi-MB blocks. */
const MAX_XLSX_ROWS_PER_SHEET = 200
/** Cap link HTML fetched before extraction. */
const MAX_LINK_HTML_BYTES = 5 * 1024 * 1024

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json'])
const IMAGE_MIME_BY_EXT: Record<string, AIImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}
const VISION_IMAGE_MIMES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : ''
}

function makeId(): string {
  // crypto.randomUUID is available in the Nitro/Node runtime.
  return globalThis.crypto?.randomUUID?.() ?? `att_${Date.now()}_${Math.round(Math.random() * 1e9)}`
}

function errorRef(input: { filename: string, mime: string, source: 'upload' | 'link', kind: AttachmentRef['kind'], error: string }): AttachmentRef {
  return { id: makeId(), source: input.source, filename: input.filename, mime: input.mime, kind: input.kind, blocks: [], error: input.error }
}

/** Decode a buffer as UTF-8 text, rejecting binary (null bytes). */
function decodeText(buffer: Buffer): string | null {
  const text = buffer.toString('utf-8')
  // A NUL byte is a reliable "this isn't text" signal.
  if (text.includes('\u0000')) return null
  return text
}

function truncateText(text: string): { text: string, truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false }
  return { text: `${text.slice(0, MAX_TEXT_CHARS)}\n…(truncated)`, truncated: true }
}

function textBlock(provenance: string, body: string): AIContentBlock {
  return { type: 'text', text: `${provenance}\n${body}` }
}

/** Per-attachment summary handed to the agent system prompt. */
export interface AttachmentSummary {
  kind: 'text' | 'document' | 'image'
  filename: string
  /** Public delivery URL when the image was uploaded to the media library. */
  url?: string
}

export interface ValidatedAttachments {
  blocks: AIContentBlock[]
  summary: AttachmentSummary[]
}

/**
 * Re-validate client-supplied attachment blocks before they enter the
 * prompt. The `/attachments` endpoint authors these blocks, but the
 * client echoes them back in the chat body, so they are untrusted on
 * the way in. Defense:
 *   - drop any block type other than text/image/document (no
 *     `tool_use`/`tool_result` injection),
 *   - drop image `url` sources that don't point at THIS project's
 *     delivery host (stops the client making Anthropic fetch arbitrary
 *     URLs as "our" image),
 *   - cap base64 lengths and total payload (DoS / body-size guard),
 *   - throw 400 on count/total-size violations.
 * Invalid individual blocks are dropped silently; only hard limits
 * throw.
 */
export function validateAttachmentBlocks(
  attachments: unknown,
  opts: { projectId: string },
): ValidatedAttachments {
  if (!Array.isArray(attachments) || attachments.length === 0)
    return { blocks: [], summary: [] }
  if (attachments.length > MAX_ATTACHMENT_COUNT)
    throw createError({ statusCode: 400, message: errorMessage('attachment.too_many', { limit: MAX_ATTACHMENT_COUNT }) })

  const deliveryPrefix = `${publicMediaBase(opts.projectId)}/`
  const blocks: AIContentBlock[] = []
  const summary: AttachmentSummary[] = []
  let totalChars = 0

  for (const raw of attachments) {
    const att = raw as { blocks?: unknown, filename?: unknown }
    const rawBlocks = Array.isArray(att?.blocks) ? att.blocks : []
    const filename = typeof att?.filename === 'string' ? att.filename : 'attachment'
    let attKind: AttachmentSummary['kind'] = 'text'
    let attUrl: string | undefined

    for (const candidate of rawBlocks) {
      const block = sanitizeBlock(candidate, deliveryPrefix)
      if (!block) continue
      blocks.push(block)
      totalChars += JSON.stringify(block).length
      if (block.type === 'image') {
        attKind = 'image'
        if (block.source.type === 'url') attUrl = block.source.url
      }
      else if (block.type === 'document') {
        attKind = 'document'
      }
    }

    if (blocks.length > 0)
      summary.push({ kind: attKind, filename, url: attUrl })
  }

  if (totalChars > MAX_TOTAL_ATTACHMENT_CHARS)
    throw createError({ statusCode: 400, message: errorMessage('attachment.payload_too_large') })

  return { blocks, summary }
}

function sanitizeBlock(candidate: unknown, deliveryPrefix: string): AIContentBlock | null {
  if (!candidate || typeof candidate !== 'object') return null
  const b = candidate as Record<string, unknown>
  switch (b.type) {
    case 'text':
      return typeof b.text === 'string'
        ? { type: 'text', text: b.text.slice(0, MAX_TEXT_CHARS) }
        : null
    case 'image': {
      const src = b.source as Record<string, unknown> | undefined
      if (!src || typeof src !== 'object') return null
      if (src.type === 'url') {
        return typeof src.url === 'string' && src.url.startsWith(deliveryPrefix)
          ? { type: 'image', source: { type: 'url', url: src.url } }
          : null
      }
      if (src.type === 'base64') {
        if (!VISION_IMAGE_MIMES.has(src.mediaType as string)) return null
        if (typeof src.data !== 'string' || src.data.length > MAX_IMAGE_BASE64_CHARS) return null
        return { type: 'image', source: { type: 'base64', mediaType: src.mediaType as AIImageMediaType, data: src.data } }
      }
      return null
    }
    case 'document': {
      const src = b.source as Record<string, unknown> | undefined
      if (!src || src.type !== 'base64' || src.mediaType !== 'application/pdf') return null
      if (typeof src.data !== 'string' || src.data.length > MAX_PDF_BASE64_CHARS) return null
      return { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: src.data } }
    }
    default:
      // Drops tool_use / tool_result / unknown — no injection path.
      return null
  }
}

/**
 * Convert an .xlsx workbook to Markdown tables (one per sheet),
 * capping rows so a huge spreadsheet doesn't blow the token budget.
 */
async function xlsxToMarkdown(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const parts: string[] = []
  wb.eachSheet((sheet) => {
    const lines: string[] = [`## Sheet: ${sheet.name}`]
    const rows: string[][] = []
    let count = 0
    sheet.eachRow((row) => {
      if (count >= MAX_XLSX_ROWS_PER_SHEET) return
      const values = (row.values as unknown[]).slice(1).map((v) => {
        if (v == null) return ''
        if (typeof v === 'object' && v !== null && 'text' in (v as Record<string, unknown>)) return String((v as { text: unknown }).text)
        if (typeof v === 'object' && v !== null && 'result' in (v as Record<string, unknown>)) return String((v as { result: unknown }).result)
        return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')
      })
      rows.push(values)
      count++
    })
    if (rows.length > 0) {
      const width = Math.max(...rows.map(r => r.length))
      const header = rows[0]!
      const headerCells = Array.from({ length: width }, (_, i) => header[i] ?? '')
      lines.push(`| ${headerCells.join(' | ')} |`)
      lines.push(`| ${headerCells.map(() => '---').join(' | ')} |`)
      for (const r of rows.slice(1)) {
        const cells = Array.from({ length: width }, (_, i) => r[i] ?? '')
        lines.push(`| ${cells.join(' | ')} |`)
      }
      if (count >= MAX_XLSX_ROWS_PER_SHEET) lines.push(`_(truncated to first ${MAX_XLSX_ROWS_PER_SHEET} rows)_`)
    }
    parts.push(lines.join('\n'))
  })
  return parts.join('\n\n')
}

/**
 * Image branch, routed by the user's explicit intent:
 *
 * - `media`   → persist to the media library and reference by a public
 *   delivery URL (the agent can place this URL into content fields).
 *   Requires the media provider + `media.upload`; surfaces an error rather
 *   than silently degrading, because the user asked for a stored asset.
 * - `context` (default) → downscale + size-cap with sharp and inline as
 *   base64 (vision-capable, ephemeral, never persisted) — regardless of plan.
 */
async function ingestImage(input: IngestFileInput, mime: AIImageMediaType): Promise<AttachmentRef> {
  const id = makeId()

  if (input.intent === 'media') {
    const media = useMediaProvider()
    if (!media || !hasFeature(input.plan, 'media.upload'))
      return errorRef({ filename: input.filename, mime, source: 'upload', kind: 'image', error: errorMessage('attachment.media_unavailable') })
    // Delivery is gated on cdn_enabled — an asset uploaded while CDN is off
    // yields a URL that 403s for the browser AND for Anthropic's fetcher
    // (which 400s the entire model call). Fail here, actionably, instead.
    if (input.cdnEnabled !== true)
      return errorRef({ filename: input.filename, mime, source: 'upload', kind: 'image', error: errorMessage('attachment.cdn_disabled') })
    try {
      const asset = await media.upload({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        file: input.buffer,
        filename: input.filename,
        contentType: mime,
        variants: resolveVariantConfig(undefined),
        uploadedBy: input.userId,
        source: 'upload',
      })
      const url = toDeliveryUrl(input.projectId, asset.originalPath)
      return {
        id,
        source: 'upload',
        filename: input.filename,
        mime,
        kind: 'image',
        destination: 'media',
        blocks: [{ type: 'image', source: { type: 'url', url } }],
        preview: url,
        bytes: asset.size,
      }
    }
    catch {
      return errorRef({ filename: input.filename, mime, source: 'upload', kind: 'image', error: errorMessage('attachment.media_upload_failed') })
    }
  }

  // Context (default): downscale + size-cap, emit base64 webp. Ephemeral.
  try {
    let optimized = await sharp(input.buffer)
      .rotate()
      .resize({ width: IMAGE_MAX_DIM, height: IMAGE_MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer()
    if (optimized.length > MAX_BASE64_IMAGE_BYTES) {
      optimized = await sharp(input.buffer)
        .rotate()
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 65 })
        .toBuffer()
    }
    if (optimized.length > MAX_BASE64_IMAGE_BYTES)
      return errorRef({ filename: input.filename, mime, source: 'upload', kind: 'image', error: errorMessage('attachment.image_too_large') })
    return {
      id,
      source: 'upload',
      filename: input.filename,
      mime: 'image/webp',
      kind: 'image',
      destination: 'context',
      blocks: [{ type: 'image', source: { type: 'base64', mediaType: 'image/webp', data: optimized.toString('base64') } }],
      bytes: optimized.length,
    }
  }
  catch {
    return errorRef({ filename: input.filename, mime, source: 'upload', kind: 'image', error: errorMessage('attachment.image_decode_failed') })
  }
}

/**
 * Ingest one uploaded file → AttachmentRef. Routing is by extension
 * with a magic-byte sanity check for binaries (anti-spoofing).
 */
export async function ingestFile(input: IngestFileInput): Promise<AttachmentRef> {
  const ext = extOf(input.filename)
  const sniff = await fileTypeFromBuffer(input.buffer).catch(() => undefined)
  const sniffedMime = sniff?.mime

  // --- Images ---
  const imageMime = IMAGE_MIME_BY_EXT[ext] ?? (VISION_IMAGE_MIMES.has(input.declaredMime) ? input.declaredMime as AIImageMediaType : undefined)
  if (imageMime) {
    if (sniffedMime && !sniffedMime.startsWith('image/'))
      return errorRef({ filename: input.filename, mime: imageMime, source: 'upload', kind: 'image', error: errorMessage('attachment.content_mismatch') })
    return ingestImage(input, imageMime)
  }

  // --- PDF (native document block) ---
  if (ext === 'pdf' || input.declaredMime === 'application/pdf') {
    if (sniffedMime && sniffedMime !== 'application/pdf')
      return errorRef({ filename: input.filename, mime: 'application/pdf', source: 'upload', kind: 'document', error: errorMessage('attachment.content_mismatch') })
    if (input.buffer.length > MAX_PDF_BYTES)
      return errorRef({ filename: input.filename, mime: 'application/pdf', source: 'upload', kind: 'document', error: errorMessage('attachment.pdf_too_large') })
    return {
      id: makeId(),
      source: 'upload',
      filename: input.filename,
      mime: 'application/pdf',
      kind: 'document',
      blocks: [{ type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: input.buffer.toString('base64') } }],
      bytes: input.buffer.length,
    }
  }

  // --- Word (.docx) ---
  if (ext === 'docx') {
    // ooxml files are zip containers; the sniffer reports a zip/office mime.
    try {
      const { value } = await mammoth.extractRawText({ buffer: input.buffer })
      const { text, truncated } = truncateText(value.trim())
      if (!text)
        return errorRef({ filename: input.filename, mime: 'docx', source: 'upload', kind: 'text', error: errorMessage('attachment.empty_extraction') })
      return {
        id: makeId(),
        source: 'upload',
        filename: input.filename,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        kind: 'text',
        blocks: [textBlock(`[Attached file: ${input.filename}]`, text)],
        preview: text.slice(0, 200),
        bytes: input.buffer.length,
        truncated,
      }
    }
    catch {
      return errorRef({ filename: input.filename, mime: 'docx', source: 'upload', kind: 'text', error: errorMessage('attachment.docx_parse_failed') })
    }
  }

  // --- Excel (.xlsx) ---
  if (ext === 'xlsx') {
    try {
      const md = (await xlsxToMarkdown(input.buffer)).trim()
      const { text, truncated } = truncateText(md)
      if (!text)
        return errorRef({ filename: input.filename, mime: 'xlsx', source: 'upload', kind: 'text', error: errorMessage('attachment.empty_extraction') })
      return {
        id: makeId(),
        source: 'upload',
        filename: input.filename,
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        kind: 'text',
        blocks: [textBlock(`[Attached spreadsheet: ${input.filename}]`, text)],
        preview: text.slice(0, 200),
        bytes: input.buffer.length,
        truncated,
      }
    }
    catch {
      return errorRef({ filename: input.filename, mime: 'xlsx', source: 'upload', kind: 'text', error: errorMessage('attachment.xlsx_parse_failed') })
    }
  }

  // --- Plain text family (csv / txt / md / tsv / json) ---
  if (TEXT_EXTENSIONS.has(ext) || input.declaredMime.startsWith('text/')) {
    const decoded = decodeText(input.buffer)
    if (decoded == null)
      return errorRef({ filename: input.filename, mime: input.declaredMime, source: 'upload', kind: 'text', error: errorMessage('attachment.not_text') })
    const fenced = (ext === 'csv' || ext === 'tsv') ? `\`\`\`\n${decoded}\n\`\`\`` : decoded
    const { text, truncated } = truncateText(fenced)
    return {
      id: makeId(),
      source: 'upload',
      filename: input.filename,
      mime: input.declaredMime || 'text/plain',
      kind: 'text',
      blocks: [textBlock(`[Attached file: ${input.filename}]`, text)],
      preview: decoded.slice(0, 200),
      bytes: input.buffer.length,
      truncated,
    }
  }

  return errorRef({ filename: input.filename, mime: input.declaredMime, source: 'upload', kind: 'text', error: errorMessage('attachment.unsupported_type', { type: ext || input.declaredMime }) })
}

/**
 * Strip a fetched HTML page down to readable text. Dependency-light:
 * remove non-content elements, prefer <article>/<main>, then de-tag.
 * Good enough for web articles and "published to web" Google
 * Docs / public Notion pages. Live private connectors are ee/roadmap.
 */
export function htmlToText(html: string): string {
  let s = html
  // Drop non-content blocks entirely (including their contents).
  s = s.replace(/<(script|style|noscript|template|svg|head|nav|footer|header|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  // Prefer main/article body if present.
  const main = s.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i)
  if (main?.[2]) s = main[2]
  // Block elements → newlines so paragraphs survive.
  s = s.replace(/<\/(p|div|section|li|h[1-6]|tr|br)\s*>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  // Strip remaining tags + decode the common entities.
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
  // Collapse whitespace.
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/**
 * Ingest a pasted URL (Channel 1). Reuses the SSRF guard
 * (`isAllowedWebhookUrl`) and fetch/timeout pattern from
 * `media-ingest.ts`. Only the *page text* is extracted; binary/media
 * URLs are rejected (use the file-upload channel or `upload_media`).
 */
export async function fetchLinkContent(rawUrl: string): Promise<AttachmentRef> {
  const url = rawUrl.trim()
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://')))
    return errorRef({ filename: url || 'link', mime: 'text/uri-list', source: 'link', kind: 'text', error: errorMessage('attachment.invalid_url') })
  if (!isAllowedWebhookUrl(url))
    return errorRef({ filename: url, mime: 'text/uri-list', source: 'link', kind: 'text', error: errorMessage('media.url_blocked') })

  let response: Response
  try {
    response = await fetch(url, { headers: { 'User-Agent': 'Contentrain-Studio/1.0' }, signal: AbortSignal.timeout(30_000), redirect: 'follow' })
  }
  catch {
    return errorRef({ filename: url, mime: 'text/uri-list', source: 'link', kind: 'text', error: errorMessage('media.url_fetch_failed') })
  }
  if (!response.ok)
    return errorRef({ filename: url, mime: 'text/uri-list', source: 'link', kind: 'text', error: errorMessage('media.url_bad_response', { status: response.status }) })

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim()
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_LINK_HTML_BYTES)
    return errorRef({ filename: url, mime: contentType, source: 'link', kind: 'text', error: errorMessage('attachment.link_too_large') })

  let body: string
  if (contentType.includes('html') || contentType === '') {
    body = htmlToText(buffer.toString('utf-8'))
  }
  else if (contentType.startsWith('text/') || contentType.includes('json')) {
    body = decodeText(buffer) ?? ''
  }
  else {
    // Binary (image/pdf/etc.) pasted as a link → not the link channel's job.
    return errorRef({ filename: url, mime: contentType, source: 'link', kind: 'text', error: errorMessage('attachment.link_not_text', { type: contentType }) })
  }

  if (!body.trim())
    return errorRef({ filename: url, mime: contentType, source: 'link', kind: 'text', error: errorMessage('attachment.empty_extraction') })

  const { text, truncated } = truncateText(body.trim())
  return {
    id: makeId(),
    source: 'link',
    filename: url,
    mime: contentType || 'text/html',
    kind: 'text',
    blocks: [textBlock(`[Attached web page: ${url}]`, text)],
    preview: text.slice(0, 200),
    bytes: buffer.length,
    truncated,
  }
}
