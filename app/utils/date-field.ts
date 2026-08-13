/**
 * Conversions between stored date values and what the browser's date inputs
 * accept.
 *
 * Content stores ISO-8601 (`2026-05-28T09:00:00.000Z`). `<input type="date">`
 * accepts only `YYYY-MM-DD` and `<input type="datetime-local">` only
 * `YYYY-MM-DDTHH:mm`. Handed anything else, the browser silently blanks the
 * field — no error, no warning — so a stored value simply disappeared from the
 * edit form and saving wrote the blank back.
 *
 * The two types are treated differently on purpose:
 *
 * - `datetime` is an **instant**, so it is shown in local time (matching how
 *   the read view formats the same value) and converted back to UTC on write.
 * - `date` is a **calendar label** with no instant attached, so it is read and
 *   written by its literal `YYYY-MM-DD` parts. Round-tripping it through local
 *   time would shift the day for anyone east or west far enough — a record
 *   dated the 28th would start reading the 29th.
 */

/** Leading `YYYY-MM-DD` of any ISO-ish string, whatever follows it. */
const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Stored value → `<input type="date">`. Empty string when there is nothing to show. */
export function toDateInputValue(stored: unknown): string {
  if (typeof stored !== 'string' || !stored) return ''
  // Read the literal prefix rather than parsing: `new Date()` would resolve to
  // an instant, and formatting that back out can land on the previous or next
  // day depending on the reader's offset.
  return ISO_DATE_PREFIX.exec(stored)?.[1] ?? ''
}

/** `<input type="date">` → stored value, kept in the ISO shape the content already uses. */
export function fromDateInputValue(input: string): string {
  if (!input) return ''
  const parsed = new Date(`${input}T00:00:00.000Z`)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
}

/** Stored value → `<input type="datetime-local">`, in the reader's local time. */
export function toDateTimeInputValue(stored: unknown): string {
  if (typeof stored !== 'string' || !stored) return ''
  // A value already written in the local-naive shape (`2026-05-28T12:00`, no
  // offset) parses as local time, which is what it meant — so records saved
  // while this was broken still load correctly.
  const parsed = new Date(stored)
  if (Number.isNaN(parsed.getTime())) return ''

  const date = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
  return `${date}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

/** `<input type="datetime-local">` → stored value, normalised back to ISO-UTC. */
export function fromDateTimeInputValue(input: string): string {
  if (!input) return ''
  // The input carries no offset; the browser means local time by it.
  const parsed = new Date(input)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
}
