/**
 * Turning raw index hits into the results a caller asked for.
 *
 * Split out of the brain worker because the interesting part is not FlexSearch,
 * it is the order of operations: the filters have to be applied *before* the
 * limit, and the worker used to do it the other way round.
 */

export interface IndexedDoc {
  modelId: string
  entryId: string
  locale: string
}

export interface SearchHit extends IndexedDoc {
  score: number
}

export interface SearchFilters {
  modelId?: string
  locale?: string
  limit: number
}

/**
 * How deep to read the index when a search is scoped.
 *
 * Sized for the case that motivated search at all — a model with ~1000 entries
 * — so a scoped search sees its own matches rather than only the ones that
 * placed globally.
 */
export const SEARCH_FILTER_FETCH_CAP = 1000

/**
 * How many hits to ask the index for.
 *
 * Asking for exactly what the caller wants and then filtering drops matches: a
 * search scoped to one model competes for those slots against every other
 * model, and a search in `tr` against every other locale. So over-fetch when a
 * filter is in play. The index is in memory; the extra reads are cheap next to
 * being wrong.
 */
export function indexFetchLimit(filters: SearchFilters): number {
  const scoped = Boolean(filters.modelId || filters.locale)
  return scoped ? Math.max(filters.limit, SEARCH_FILTER_FETCH_CAP) : filters.limit
}

/**
 * Apply the filters, drop duplicates, then cut to size.
 *
 * FlexSearch returns one result set per indexed field, so the same document can
 * appear more than once; without dedup a single entry eats several slots of the
 * caller's limit.
 */
export function collectSearchHits(
  docIds: Iterable<string>,
  lookup: (id: string) => IndexedDoc | null | undefined,
  filters: SearchFilters,
): SearchHit[] {
  const hits: SearchHit[] = []
  const seen = new Set<string>()

  for (const rawId of docIds) {
    const id = String(rawId)
    if (seen.has(id)) continue
    seen.add(id)

    const doc = lookup(id)
    if (!doc) continue
    if (filters.modelId && doc.modelId !== filters.modelId) continue
    if (filters.locale && doc.locale !== filters.locale) continue

    hits.push({ modelId: doc.modelId, entryId: doc.entryId, locale: doc.locale, score: 1 })
    if (hits.length >= filters.limit) break
  }

  return hits
}
