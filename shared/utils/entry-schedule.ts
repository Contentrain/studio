/**
 * Entry scheduling window — the single reading of `publish_at` / `expire_at`
 * shared by everything that has to agree on it.
 *
 * Two consumers, and they must never drift apart:
 *   - `cdn-builder.ts` decides what a build delivers;
 *   - `schema-validation.ts` reports a schedule the builder cannot read, so a
 *     value that silently removes an entry from delivery is visible in project
 *     health instead of being invisible.
 *
 * Boundary semantics match `@contentrain/query`'s published-window filter:
 * the window is inclusive at `publish_at` and exclusive at `expire_at`, so an
 * entry goes live exactly at its publish moment and is gone exactly at its
 * expiry moment. Scheduling is meta-only (MCP 3.1.8) and never touches
 * `status`; a draft stays a draft whatever its window says.
 */

/** Absent → `undefined`. Present but unreadable → `null`. Otherwise epoch ms. */
export function parseScheduleTime(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

export interface EntrySchedule {
  publish_at?: unknown
  expire_at?: unknown
}

/**
 * The schedule keys whose value is present but unreadable. Empty when the
 * entry has no schedule or every value parses.
 */
export function invalidScheduleKeys(schedule: EntrySchedule | null | undefined): Array<'publish_at' | 'expire_at'> {
  if (!schedule || typeof schedule !== 'object') return []
  const invalid: Array<'publish_at' | 'expire_at'> = []
  for (const key of ['publish_at', 'expire_at'] as const) {
    if (parseScheduleTime((schedule as Record<string, unknown>)[key]) === null) invalid.push(key)
  }
  return invalid
}

/**
 * Is `at` inside the entry's window? An unreadable value answers `false`: a
 * window that cannot be read is not a window an entry can be delivered
 * through, and `invalidScheduleKeys` is what makes that visible.
 */
export function isWithinSchedule(schedule: EntrySchedule | null | undefined, at: number): boolean {
  if (!schedule || typeof schedule !== 'object') return true
  const publishAt = parseScheduleTime((schedule as Record<string, unknown>).publish_at)
  if (publishAt === null || (publishAt !== undefined && publishAt > at)) return false
  const expireAt = parseScheduleTime((schedule as Record<string, unknown>).expire_at)
  if (expireAt === null || (expireAt !== undefined && expireAt <= at)) return false
  return true
}
