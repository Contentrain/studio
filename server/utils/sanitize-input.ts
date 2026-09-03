/**
 * Input sanitizer for public, unauthenticated write surfaces (form
 * submissions, comments). Strips HTML tags, entity-hidden tags and inline
 * script vectors so nothing that reaches the database can render as markup.
 * Output is plain text; renderers escape it again.
 */

export function sanitizeString(value: string): string {
  let s = value
  // 1. Strip HTML tags first (before any entity decoding)
  s = s.replace(/<[^>]*>/g, '')
  // 2. Remove dangerous patterns
  s = s.replace(/javascript:/gi, '')
  s = s.replace(/on\w+\s*=/gi, '')
  // 3. Decode entities that might hide tags, then strip again
  s = s.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  s = s.replace(/&#x3[cC];/g, '<').replace(/&#x3[eE];/g, '>')
  s = s.replace(/&#60;/g, '<').replace(/&#62;/g, '>')
  s = s.replace(/<[^>]*>/g, '')
  // 4. Final pass for any remaining dangerous patterns
  s = s.replace(/javascript:/gi, '')
  s = s.replace(/on\w+\s*=/gi, '')
  return s
}

/** Recursively sanitize every string value in an object. */
export function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value)
    }
    else if (Array.isArray(value)) {
      sanitized[key] = value.map(item =>
        typeof item === 'string'
          ? sanitizeString(item)
          : (item && typeof item === 'object' && !Array.isArray(item))
              ? sanitizeData(item as Record<string, unknown>)
              : item,
      )
    }
    else if (value && typeof value === 'object') {
      sanitized[key] = sanitizeData(value as Record<string, unknown>)
    }
    else {
      sanitized[key] = value
    }
  }

  return sanitized
}

/**
 * HTML → plain text for imported comment bodies: block boundaries become
 * newlines, tags are dropped, the common entities are decoded, then the
 * result goes through `sanitizeString` like any other public input.
 */
export function htmlToPlainText(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, '\'')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return sanitizeString(text).trim()
}
