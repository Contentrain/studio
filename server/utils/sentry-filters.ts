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
 * Duck-types `statusCode` instead of `instanceof H3Error`: `beforeSend`
 * only ever sees whatever was thrown, and an `instanceof` check silently
 * stops matching the moment two copies of `h3` end up installed.
 */
export function isExpectedHttpError(exception: unknown): boolean {
  if (!exception || typeof exception !== 'object' || !('statusCode' in exception)) return false
  const statusCode = (exception as { statusCode: unknown }).statusCode
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
}
