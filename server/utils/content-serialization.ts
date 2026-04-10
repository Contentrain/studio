import type { FieldDef } from '@contentrain/types'
import {
  canonicalStringify,
  generateEntryId,
  parseMarkdownFrontmatter,
  serializeMarkdownFrontmatter,
} from '@contentrain/types'

/**
 * Canonical content serialization for Studio.
 *
 * Pure serialization functions (sortKeys, canonicalStringify, generateEntryId,
 * parseMarkdownFrontmatter, serializeMarkdownFrontmatter) are delegated to
 * @contentrain/types — single source of truth shared with MCP.
 *
 * Studio-specific: cleanData() (omitNull + omitDefaults) before serialization.
 */

// Re-export types functions used by other Studio modules
export { generateEntryId, parseMarkdownFrontmatter, serializeMarkdownFrontmatter }

/**
 * Remove null values and defaults from an object.
 * Studio-specific: types' canonicalStringify handles sortKeys + indent,
 * but null/default cleanup depends on FieldDef context only Studio has.
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
 * Applies Studio-specific cleanData (omitNull/omitDefaults) before
 * delegating to @contentrain/types canonicalStringify.
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

  return canonicalStringify(processed)
}
