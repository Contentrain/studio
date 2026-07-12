/**
 * Validate a post-login redirect target from a query param: same-origin
 * paths only. Rejects absolute URLs, protocol-relative `//host` and the
 * `/\host` backslash trick browsers normalize into a cross-origin hop.
 */
export function safeInternalRedirect(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (!value.startsWith('/')) return null
  if (value.startsWith('//') || value.startsWith('/\\')) return null
  return value
}
