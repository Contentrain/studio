/**
 * Server-side Sentry `beforeSend` filters.
 *
 * Pulled out of `sentry.server.config.ts` (which runs before Nuxt's runtime
 * context exists, so it isn't itself under test) so the filtering logic is
 * unit-testable on its own.
 */

/**
 * Whether an exception is an expected 4xx HTTP failure — an unauthenticated
 * request, a forbidden action, a scanner probe hitting an unmatched route —
 * rather than a real error. These are normal traffic, not incidents, and
 * burying real errors under a few hundred of them per day (#296) is worse
 * than not reporting them at all. Every 5xx still gets through.
 *
 * Duck-types instead of `instanceof H3Error`: `beforeSend` only ever sees
 * whatever was thrown, and an `instanceof` check silently stops matching
 * the moment two copies of `h3` end up installed. `statusCode` alone isn't
 * a safe enough signal — `ofetch`'s `FetchError` can carry one too, and
 * this must not swallow a real failure from an outbound HTTP call. `h3`'s
 * `H3Error` also sets `unhandled` (default `false`, `true` only for an
 * error h3 itself had to wrap unexpectedly) — a field `FetchError` and
 * plain `Error`s never have — so requiring it narrows this to genuine
 * `createError()` results.
 */
export function isExpectedHttpError(exception: unknown): boolean {
  if (!exception || typeof exception !== 'object') return false
  const err = exception as { statusCode?: unknown, unhandled?: unknown }
  if (typeof err.statusCode !== 'number' || err.statusCode < 400 || err.statusCode >= 500) return false
  return err.unhandled === false
}
