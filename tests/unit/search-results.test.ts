import { describe, expect, it } from 'vitest'
import {
  SEARCH_FILTER_FETCH_CAP,
  collectSearchHits,
  indexFetchLimit,
} from '../../app/utils/search-results'

const INDEX: Record<string, { modelId: string, entryId: string, locale: string }> = {
  'articles:en:a1': { modelId: 'articles', entryId: 'a1', locale: 'en' },
  'articles:tr:a1': { modelId: 'articles', entryId: 'a1', locale: 'tr' },
  'articles:en:a2': { modelId: 'articles', entryId: 'a2', locale: 'en' },
  'authors:en:u1': { modelId: 'authors', entryId: 'u1', locale: 'en' },
  'authors:en:u2': { modelId: 'authors', entryId: 'u2', locale: 'en' },
}

const lookup = (id: string) => INDEX[id] ?? null

describe('indexFetchLimit', () => {
  it('reads deeper when the search is scoped', () => {
    // Asking the index for exactly the caller's limit and filtering afterwards
    // is what let another model's hits eat every slot.
    expect(indexFetchLimit({ limit: 10 })).toBe(10)
    expect(indexFetchLimit({ limit: 10, modelId: 'articles' })).toBe(SEARCH_FILTER_FETCH_CAP)
    expect(indexFetchLimit({ limit: 10, locale: 'tr' })).toBe(SEARCH_FILTER_FETCH_CAP)
  })

  it('never reads less than the caller asked for', () => {
    expect(indexFetchLimit({ limit: 5000, modelId: 'articles' })).toBe(5000)
  })
})

describe('collectSearchHits', () => {
  it('filters by model before applying the limit, not after', () => {
    // The reported shape of the bug: two `authors` hits rank above the article,
    // so a 2-result search scoped to `articles` used to return nothing.
    const ranked = ['authors:en:u1', 'authors:en:u2', 'articles:en:a1']

    expect(collectSearchHits(ranked, lookup, { limit: 2, modelId: 'articles' }))
      .toEqual([{ modelId: 'articles', entryId: 'a1', locale: 'en', score: 1 }])
  })

  it('filters by locale, so a Turkish list does not list English hits', () => {
    const ranked = ['articles:en:a1', 'articles:tr:a1']

    expect(collectSearchHits(ranked, lookup, { limit: 10, locale: 'tr' }))
      .toEqual([{ modelId: 'articles', entryId: 'a1', locale: 'tr', score: 1 }])
  })

  it('applies both filters together', () => {
    const ranked = ['authors:en:u1', 'articles:en:a1', 'articles:tr:a1']

    expect(collectSearchHits(ranked, lookup, { limit: 10, modelId: 'articles', locale: 'tr' }))
      .toEqual([{ modelId: 'articles', entryId: 'a1', locale: 'tr', score: 1 }])
  })

  it('does not let one document occupy two slots', () => {
    // FlexSearch returns a set per indexed field, so the same id can repeat.
    const ranked = ['articles:en:a1', 'articles:en:a1', 'articles:en:a2']

    expect(collectSearchHits(ranked, lookup, { limit: 2 })).toEqual([
      { modelId: 'articles', entryId: 'a1', locale: 'en', score: 1 },
      { modelId: 'articles', entryId: 'a2', locale: 'en', score: 1 },
    ])
  })

  it('stops at the limit', () => {
    const ranked = Object.keys(INDEX)
    expect(collectSearchHits(ranked, lookup, { limit: 3 })).toHaveLength(3)
  })

  it('skips ids the index no longer knows', () => {
    // The index is rebuilt per sync; a stale id must not become a null row.
    expect(collectSearchHits(['gone:en:x', 'articles:en:a1'], lookup, { limit: 10 }))
      .toEqual([{ modelId: 'articles', entryId: 'a1', locale: 'en', score: 1 }])
  })

  it('returns nothing rather than everything when there are no hits', () => {
    expect(collectSearchHits([], lookup, { limit: 10 })).toEqual([])
  })
})
