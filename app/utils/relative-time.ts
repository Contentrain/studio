/**
 * "2h ago" from a timestamp, using the dictionary's `time.*` strings.
 *
 * The same four-line ladder was written out in ChatPanel, ProjectCard,
 * SubmissionListView and ConversationKeysPanel; the review panel would have
 * been the fifth. New callers use this one.
 */

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * @param value ISO string, epoch milliseconds, or Unix seconds (a `cr/*`
 *   branch name carries the last of those).
 */
export function formatRelativeTime(value: string | number | null | undefined, t: Translate): string {
  if (value === null || value === undefined || value === '') return ''

  // Ten digits is a Unix-seconds stamp; anything shorter as milliseconds would
  // be 1970, which no content carries.
  const ms = typeof value === 'number'
    ? (value < 1e11 ? value * 1000 : value)
    : new Date(value).getTime()
  if (Number.isNaN(ms)) return ''

  const elapsed = Date.now() - ms
  const minutes = Math.floor(elapsed / 60000)
  const hours = Math.floor(elapsed / 3600000)
  const days = Math.floor(elapsed / 86400000)

  if (minutes < 60) return t('time.minutes_ago', { count: Math.max(1, minutes) })
  if (hours < 24) return t('time.hours_ago', { count: hours })
  return t('time.days_ago', { count: days })
}
