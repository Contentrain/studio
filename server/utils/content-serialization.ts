import type { FieldDef } from '@contentrain/types'
import { CANONICAL_JSON } from '@contentrain/types'

/**
 * Canonical JSON serialization for Contentrain content.
 * Implements CANONICAL_JSON rules from @contentrain/types:
 * - indent: 2 spaces
 * - encoding: utf-8
 * - trailingNewline: true
 * - omitNull: true
 * - omitDefaults: true
 * - sortKeys: true
 *
 * This ensures Studio-written JSON is byte-identical to MCP-written JSON.
 */

/**
 * Sort object keys recursively for deterministic output.
 */
function sortKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj
  if (Array.isArray(obj)) return obj.map(sortKeys)
  if (typeof obj !== 'object') return obj

  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key])
  }
  return sorted
}

/**
 * Remove null values and defaults from an object.
 */
function cleanData(
  data: Record<string, unknown>,
  fieldDefs?: Record<string, FieldDef>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(data)) {
    // omitNull
    if (value === null || value === undefined) continue

    // omitDefaults — skip if value matches field default
    if (fieldDefs) {
      const def = fieldDefs[key]
      if (def && def.default !== undefined && def.default === value) continue
    }

    cleaned[key] = value
  }

  return cleaned
}

/**
 * Serialize data to canonical JSON string.
 * Matches @contentrain/types CANONICAL_JSON spec exactly.
 */
export function serializeCanonical(
  data: unknown,
  fieldDefs?: Record<string, FieldDef>,
): string {
  let processed = data

  // Clean top-level object (omit null/defaults)
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    processed = cleanData(data as Record<string, unknown>, fieldDefs)
  }

  // Sort keys recursively
  processed = sortKeys(processed)

  // Stringify with canonical indent
  let json = JSON.stringify(processed, null, CANONICAL_JSON.indent)

  // Trailing newline
  if (CANONICAL_JSON.trailingNewline) {
    json += '\n'
  }

  return json
}

/**
 * Generate a 12-character hex entry ID.
 * Matches @contentrain/types ENTRY_ID_PATTERN.
 */
export function generateEntryId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}
