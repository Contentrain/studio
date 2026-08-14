/**
 * Token-scored matching for the agent's `brain_search` tool.
 *
 * The previous implementation substring-matched the query against
 * `JSON.stringify(entry)`, so a query was only found when it appeared as
 * one contiguous run inside the serialized JSON. Real queries concatenate
 * across fields ("Review" title + "Approve branches…" description) and
 * never match that way — in the 2026-08-13 staging sessions 5 of 7
 * searches returned zero results and pushed the agent into full-model
 * dumps and a wrong-entry pick.
 *
 * Matching here is per-token over the entry's string VALUES only (no JSON
 * syntax, no keys): every query token must appear somewhere, but not
 * contiguously and not in field order. Pure functions — no Nuxt context —
 * so the scoring is unit-testable in isolation.
 */

/** Recursively collect string values (nested objects/arrays included). */
export function collectSearchableText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null || depth > 6) return ''

  const parts: string[] = []
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  for (const v of values) {
    if (typeof v === 'string') {
      if (v.length > 0) parts.push(v)
    }
    else if (typeof v === 'object' && v !== null) {
      const nested = collectSearchableText(v, depth + 1)
      if (nested) parts.push(nested)
    }
  }
  return parts.join(' ')
}

/** Lowercased, deduplicated word tokens; 1-char tokens carry no signal. */
export function tokenizeQuery(query: string): string[] {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []
  return [...new Set(tokens)]
}

/**
 * Fraction of query tokens present in the entry text (substring match, so
 * "review" also hits "reviewer" — mirroring the forward tokenization the
 * content panel's client-side search uses).
 */
export function scoreEntryText(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const haystack = text.toLowerCase()
  let matched = 0
  for (const token of tokens) {
    if (haystack.includes(token)) matched++
  }
  return matched / tokens.length
}

/** Entries scoring below this are noise, not partial matches. */
export const BRAIN_SEARCH_MIN_SCORE = 0.5
