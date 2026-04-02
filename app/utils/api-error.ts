/**
 * Centralized API error resolver for user-facing messages.
 *
 * Backend uses errorMessage() which returns user-friendly strings from
 * Contentrain dictionary for 4xx responses. 5xx responses contain raw
 * infrastructure errors (Supabase, Stripe, GitHub) that must NEVER
 * be shown to users.
 *
 * Strategy:
 *   4xx → backend message is user-friendly, use it
 *   5xx → always use the provided fallback (translated string)
 *   Network/unknown → generic connection error fallback
 */

interface FetchError {
  statusCode?: number
  status?: number
  data?: { message?: string, statusCode?: number, statusMessage?: string }
  message?: string
}

/**
 * Extract a user-safe error message from an API error.
 *
 * @param error - The caught error (unknown type from catch block)
 * @param fallback - Pre-translated fallback string for 5xx / unknown errors
 * @returns User-safe error message string
 *
 * @example
 * ```ts
 * catch (e) {
 *   toast.error(resolveApiError(e, t('members.invite_error')))
 * }
 * ```
 */
export function resolveApiError(error: unknown, fallback: string): string {
  if (!error) return fallback

  const err = error as FetchError

  // Determine HTTP status code from various error shapes
  const status = err.statusCode
    ?? err.status
    ?? err.data?.statusCode
    ?? 0

  // 4xx client errors — backend message is user-friendly (from errorMessage())
  if (status >= 400 && status < 500) {
    const message = err.data?.message ?? err.message
    if (message) return message
  }

  // 5xx, network errors, unknown — never expose raw message
  return fallback
}
