import type { FieldDef, FieldType, ModelDefinition } from '@contentrain/types'
import { rewriteMediaUrl, toDeliveryUrl } from './media-url'

/**
 * Media path → delivery URL rewriting.
 *
 * Studio stores uploaded media in CDN/R2 and references it from content by a
 * relative storage path (`media/original/x.webp`). That path renders nowhere
 * on its own — it needs to become an absolute, public delivery URL before it
 * reaches a browser. This module is the single rewrite implementation, used at
 * two points:
 *
 *  - Content write (save-content / save-document): so the git-committed value
 *    is already a ready-to-use URL. Any consumer — `@contentrain/query` (CDN or
 *    local mode), raw markdown, a plain landing page, a mobile app — can use it
 *    directly without an SDK or integration code.
 *  - CDN publish (cdn-builder): an idempotent safety net for any relative path
 *    that reaches the published artifact from another writer (e.g. legacy
 *    content, external markdown, MCP Cloud writes).
 *
 * Only image/video/file fields (resolved via the model schema, including those
 * nested in object/array fields) and `media/...` src/href targets in
 * markdown/HTML are rewritten. External URLs (`http(s)://`, `//`, `data:`) and
 * already-absolute delivery URLs pass through untouched, so every entry point
 * is safe to call repeatedly.
 */

const MEDIA_FIELD_TYPES = new Set<FieldType>(['image', 'video', 'file'])

/**
 * Rewrite media paths within a single field value, guided by its FieldDef so
 * only media fields — including those nested inside object/array fields — are
 * touched. Non-media values pass through.
 */
export function rewriteFieldMedia(value: unknown, field: FieldDef, projectId: string): unknown {
  if (value == null) return value

  if (MEDIA_FIELD_TYPES.has(field.type))
    return rewriteMediaUrl(projectId, value)

  if (field.type === 'object' && field.fields && typeof value === 'object' && !Array.isArray(value))
    return rewriteEntryMedia(value as Record<string, unknown>, field.fields, projectId)

  if (field.type === 'array' && Array.isArray(value)) {
    const itemDef: FieldDef | null = typeof field.items === 'string'
      ? { type: field.items as FieldType }
      : field.items ?? null
    if (!itemDef) return value
    return value.map(v => rewriteFieldMedia(v, itemDef, projectId))
  }

  return value
}

/**
 * Rewrite media paths across one entry/frontmatter object using a field map.
 * Returns a shallow copy (the input is never mutated); a no-op when the object
 * has no media fields.
 */
export function rewriteEntryMedia(
  entry: Record<string, unknown>,
  fields: Record<string, FieldDef>,
  projectId: string,
): Record<string, unknown> {
  const out = { ...entry }
  for (const [fieldId, field] of Object.entries(fields)) {
    if (fieldId in out)
      out[fieldId] = rewriteFieldMedia(out[fieldId], field, projectId)
  }
  return out
}

/** Rewrite `media/...` markdown image/link targets and inline src/href attrs. */
export function rewriteMarkdownMedia(body: string, projectId: string): string {
  return body
    // markdown image/link target: ](media/...) — stops at whitespace, ) or "
    .replace(/(\]\()(media\/[^)\s"]+)/g, (_m, open, p) => `${open}${toDeliveryUrl(projectId, p)}`)
    // inline HTML src=/href="media/..."
    .replace(/(\s(?:src|href)=)(["'])(media\/[^"']+)\2/gi,
      (_m, attr, quote, p) => `${attr}${quote}${toDeliveryUrl(projectId, p)}${quote}`)
}

/**
 * Extract the relative media-storage path (`media/...`) from a field value,
 * whether it is stored as a bare path or as an absolute delivery URL
 * (`https://host/api/cdn/v1/{projectId}/media/...`). Returns null for
 * non-media values. Used by usage tracking so it matches an asset regardless of
 * which form the content stores.
 */
export function extractMediaStoragePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.startsWith('media/')) return value
  const match = value.match(/\/(media\/[^?#\s"']+)/)
  return match ? match[1]! : null
}

/**
 * Normalize every media reference in a model's content payload to delivery
 * URLs. Handles the collection (id → entry map) and singleton (single object)
 * shapes; dictionaries hold only translation strings and are returned as-is.
 * The input is never mutated. A no-op when the model has no fields.
 */
export function normalizeModelContentMedia(
  model: ModelDefinition,
  content: unknown,
  projectId: string,
): unknown {
  const fields = model.fields
  if (!fields || !content || typeof content !== 'object') return content

  if (model.kind === 'collection') {
    const out: Record<string, unknown> = {}
    for (const [id, entry] of Object.entries(content as Record<string, unknown>)) {
      out[id] = entry && typeof entry === 'object' && !Array.isArray(entry)
        ? rewriteEntryMedia(entry as Record<string, unknown>, fields, projectId)
        : entry
    }
    return out
  }

  if (model.kind === 'singleton' && !Array.isArray(content))
    return rewriteEntryMedia(content as Record<string, unknown>, fields, projectId)

  return content
}
