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

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: '\u00A0',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  deg: '°',
  times: '×',
  divide: '÷',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  para: '¶',
  sect: '§',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200C',
  zwj: '\u200D',
  shy: '\u00AD',
}

/**
 * Decode HTML character references — numeric (`&#8217;`, `&#x2019;`) and the
 * named ones WordPress emits (`&rsquo;`, `&hellip;`, `&nbsp;`, …). Unknown
 * names are left as written. Output is text, not markup: callers that need
 * safety run it through `sanitizeString` afterwards, which strips any tag a
 * decoded `&lt;` may have re-formed.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return match
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[ref] ?? NAMED_ENTITIES[ref.toLowerCase()] ?? match
  })
}

/**
 * HTML → plain text for imported comment bodies: block boundaries become
 * newlines, tags are dropped, character references are decoded, then the
 * result goes through `sanitizeString` like any other public input (so an
 * entity-encoded tag is still stripped, never rendered).
 */
export function htmlToPlainText(html: string): string {
  const text = decodeHtmlEntities(html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return sanitizeString(text).trim()
}
