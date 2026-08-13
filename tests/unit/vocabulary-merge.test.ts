import { describe, expect, it } from 'vitest'
import {
  applyVocabularyPatch,
  vocabularyPatchSatisfied,
  type Vocabulary,
} from '../../server/utils/vocabulary-merge'

const base: Vocabulary = {
  version: 1,
  terms: {
    brand: { tr: 'Collabers' },
    creator: { tr: 'creator', en: 'creator' },
  },
}

describe('applyVocabularyPatch', () => {
  it('adds a term without touching the others', () => {
    const next = applyVocabularyPatch(base, { agency: { tr: 'ajans' } })

    expect(next.terms.agency).toEqual({ tr: 'ajans' })
    expect(next.terms.brand).toEqual({ tr: 'Collabers' })
    expect(next.terms.creator).toEqual({ tr: 'creator', en: 'creator' })
  })

  it('merges a new locale into an existing term', () => {
    const next = applyVocabularyPatch(base, { brand: { en: 'Collabers' } })

    expect(next.terms.brand).toEqual({ tr: 'Collabers', en: 'Collabers' })
  })

  it('deletes on null and leaves the rest', () => {
    const next = applyVocabularyPatch(base, { brand: null })

    expect(next.terms.brand).toBeUndefined()
    expect(next.terms.creator).toBeDefined()
  })

  it('keeps the version and survives a seed with no terms', () => {
    const next = applyVocabularyPatch({ version: 1, terms: {} }, { brand: { tr: 'Collabers' } })

    expect(next).toEqual({ version: 1, terms: { brand: { tr: 'Collabers' } } })
  })

  it('does not mutate the snapshot it was given', () => {
    applyVocabularyPatch(base, { brand: null, agency: { tr: 'ajans' } })

    expect(base.terms.brand).toEqual({ tr: 'Collabers' })
    expect(base.terms.agency).toBeUndefined()
  })
})

describe('vocabularyPatchSatisfied', () => {
  it('accepts a landed addition', () => {
    expect(vocabularyPatchSatisfied(base, { brand: { tr: 'Collabers' } })).toBe(true)
  })

  it('rejects the lost update this endpoint exists to catch', () => {
    // Two saves forked the same commit; the other one merged last and its
    // snapshot — without our term — is what landed.
    const landed: Vocabulary = { version: 1, terms: { creator: { tr: 'creator' } } }

    expect(vocabularyPatchSatisfied(landed, { brand: { tr: 'Collabers' } })).toBe(false)
  })

  it('ignores what a concurrent writer added alongside us', () => {
    // Someone else's term appearing is a fine outcome, not a failure.
    const landed: Vocabulary = {
      version: 1,
      terms: { brand: { tr: 'Collabers' }, unrelated: { tr: 'başka' } },
    }

    expect(vocabularyPatchSatisfied(landed, { brand: { tr: 'Collabers' } })).toBe(true)
  })

  it('rejects a partial locale merge', () => {
    const landed: Vocabulary = { version: 1, terms: { brand: { tr: 'Collabers' } } }

    expect(vocabularyPatchSatisfied(landed, { brand: { en: 'Collabers' } })).toBe(false)
  })

  it('rejects a stale value under the right key', () => {
    const landed: Vocabulary = { version: 1, terms: { brand: { tr: 'Eski' } } }

    expect(vocabularyPatchSatisfied(landed, { brand: { tr: 'Collabers' } })).toBe(false)
  })

  it('treats a deletion as satisfied only once the term is gone', () => {
    expect(vocabularyPatchSatisfied(base, { brand: null })).toBe(false)
    expect(vocabularyPatchSatisfied({ version: 1, terms: {} }, { brand: null })).toBe(true)
  })

  it('survives a vocabulary with no terms object at all', () => {
    const landed = { version: 1 } as unknown as Vocabulary

    expect(vocabularyPatchSatisfied(landed, { brand: { tr: 'x' } })).toBe(false)
    expect(vocabularyPatchSatisfied(landed, { brand: null })).toBe(true)
  })
})
