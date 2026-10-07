/**
 * http(s)-only URLs for values that end up as a link on someone else's page
 * (a comment author's website). Anything else, `javascript:`, `data:`, `vbscript:`,
 * a relative or unparseable string, is rejected, never rewritten.
 */

const MAX_URL_LENGTH = 2048

function parseHttp(value: string | null | undefined): URL | null {
  if (!value) return null
  try {
    const url = new URL(String(value).trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  }
  catch {
    return null
  }
}

/** For writes: the absolute http(s) URL in its canonical form, capped at 2048 characters, or null. */
export function normalizeHttpUrl(value: string | null | undefined): string | null {
  return parseHttp(value)?.toString().slice(0, MAX_URL_LENGTH) ?? null
}

/** For reads: the stored string as it is when it is an http(s) URL (nothing re-serialized), else null. */
export function onlyHttpUrl(value: string | null | undefined): string | null {
  return parseHttp(value) ? String(value) : null
}
