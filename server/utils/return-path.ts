/**
 * A checkout may send the customer back to a page that sent them there
 * (the Migrate claim). Only a short list of internal paths is accepted:
 * anything else — absolute URLs, `//host`, backslashes, other pages — is
 * dropped and the caller keeps its default, so this cannot be an open redirect.
 */
const ALLOWED_PREFIXES = ['/migrate/claim']

export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return null
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null
  // eslint-disable-next-line no-control-regex -- reject control characters (header/URL smuggling)
  if (/[\u0000-\u001F\u007F]/.test(raw)) return null
  let url: URL
  try {
    url = new URL(raw, 'https://internal.invalid')
  }
  catch {
    return null
  }
  if (url.origin !== 'https://internal.invalid') return null
  const allowed = ALLOWED_PREFIXES.some(p => url.pathname === p || url.pathname.startsWith(`${p}/`))
  return allowed ? `${url.pathname}${url.search}` : null
}
