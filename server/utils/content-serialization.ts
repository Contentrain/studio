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

/**
 * Parse markdown frontmatter (YAML between --- delimiters).
 * Returns { frontmatter, body } where frontmatter is a parsed object.
 */
export function parseMarkdownFrontmatter(raw: string): { frontmatter: Record<string, unknown>, body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: raw }
  }

  const yamlBlock = match[1] ?? ''
  const body = match[2] ?? ''

  // Simple YAML parser (key: value, arrays with - prefix)
  const frontmatter: Record<string, unknown> = {}
  let currentKey: string | null = null
  let currentArray: string[] | null = null

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Array item
    if (trimmed.startsWith('- ') && currentKey) {
      if (!currentArray) currentArray = []
      currentArray.push(trimmed.slice(2).trim())
      continue
    }

    // Flush previous array
    if (currentKey && currentArray) {
      frontmatter[currentKey] = currentArray
      currentArray = null
    }

    // Key: value pair
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx > 0) {
      currentKey = trimmed.slice(0, colonIdx).trim()
      const val = trimmed.slice(colonIdx + 1).trim()
      if (val === '') {
        // Might be an array or empty value — wait for next line
        continue
      }
      // Parse value types
      if (val === 'true') frontmatter[currentKey] = true
      else if (val === 'false') frontmatter[currentKey] = false
      else if (val === 'null') frontmatter[currentKey] = null
      else if (/^-?\d+$/.test(val)) frontmatter[currentKey] = Number.parseInt(val)
      else if (/^-?\d+\.\d+$/.test(val)) frontmatter[currentKey] = Number.parseFloat(val)
      else frontmatter[currentKey] = val
    }
  }

  // Flush final array
  if (currentKey && currentArray) {
    frontmatter[currentKey] = currentArray
  }

  return { frontmatter, body }
}

/**
 * Serialize frontmatter + body to markdown string.
 */
export function serializeMarkdownFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const lines: string[] = ['---']

  for (const [key, value] of Object.entries(frontmatter).sort(([a], [b]) => a.localeCompare(b))) {
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const item of value) {
        lines.push(`  - ${String(item)}`)
      }
    }
    else {
      lines.push(`${key}: ${String(value)}`)
    }
  }

  lines.push('---')
  lines.push('')
  lines.push(body)

  return lines.join('\n')
}
