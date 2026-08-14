import { describe, expect, it } from 'vitest'
import { BRAIN_SEARCH_MIN_SCORE, collectSearchableText, scoreEntryText, tokenizeQuery } from '../../server/utils/brain-search'

describe('collectSearchableText', () => {
  it('collects nested string values, skipping keys and non-strings', () => {
    const entry = {
      title: 'Review',
      count: 3,
      meta: { description: 'Approve branches before changes become production content.' },
      cards: [{ label: 'Nested card' }, 'bare string'],
    }
    const text = collectSearchableText(entry)
    expect(text).toContain('Review')
    expect(text).toContain('Approve branches')
    expect(text).toContain('Nested card')
    expect(text).toContain('bare string')
    expect(text).not.toContain('title')
    expect(text).not.toContain('meta')
  })

  it('returns the string itself for a string input and empty for scalars', () => {
    expect(collectSearchableText('hello')).toBe('hello')
    expect(collectSearchableText(42)).toBe('')
    expect(collectSearchableText(null)).toBe('')
  })
})

describe('tokenizeQuery', () => {
  it('lowercases, splits on non-word chars, dedupes, and drops 1-char tokens', () => {
    expect(tokenizeQuery('Review: Approve branches, review!')).toEqual(['review', 'approve', 'branches'])
  })

  it('keeps unicode words (Turkish)', () => {
    expect(tokenizeQuery('görseli değiştir')).toEqual(['görseli', 'değiştir'])
  })
})

describe('scoreEntryText', () => {
  // The exact staging failure (2026-08-13): the entry's title is "Review"
  // and its description is "Approve branches before changes become
  // production content." — the user-visible card text concatenates them,
  // so the old contiguous JSON.stringify substring match found nothing.
  const entry = {
    title: 'Review',
    description: 'Approve branches before changes become production content.',
  }
  const text = collectSearchableText(entry)

  it('matches a query spanning two fields (the staging regression)', () => {
    const tokens = tokenizeQuery('Review Approve branches before changes become production content')
    expect(scoreEntryText(text, tokens)).toBe(1)
  })

  it('matches word subsets sampled from the middle of a sentence', () => {
    const tokens = tokenizeQuery('Approve branches production content')
    expect(scoreEntryText(text, tokens)).toBe(1)
  })

  it('scores partial matches proportionally, below full matches', () => {
    const tokens = tokenizeQuery('approve branches kangaroo')
    const score = scoreEntryText(text, tokens)
    expect(score).toBeGreaterThanOrEqual(BRAIN_SEARCH_MIN_SCORE)
    expect(score).toBeLessThan(1)
  })

  it('rejects unrelated queries', () => {
    const tokens = tokenizeQuery('pricing plans enterprise tier')
    expect(scoreEntryText(text, tokens)).toBeLessThan(BRAIN_SEARCH_MIN_SCORE)
  })

  it('substring-matches inside longer words (forward tokenization)', () => {
    expect(scoreEntryText('the reviewer approves', tokenizeQuery('review'))).toBe(1)
  })
})
