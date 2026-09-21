/**
 * Canonical UUID shape, as Postgres accepts it in a `uuid` column.
 *
 * Deliberately loose about version and variant bits. This exists to keep
 * a non-uuid out of a query, not to prove where an id came from — a
 * stricter pattern would reject ids from a generator nobody has thought
 * about yet, and buy nothing for it.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
