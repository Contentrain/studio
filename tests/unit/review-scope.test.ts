import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { reviewScopeKey } from '../../app/utils/review-scope'

const dictionary = JSON.parse(readFileSync('.contentrain/content/system/ui-strings/en.json', 'utf8')) as Record<string, string>

describe('reviewScopeKey', () => {
  it('names every scope a cr/* branch is opened under with a key the dictionary defines', () => {
    for (const scope of ['bulk', 'config', 'content', 'fix', 'media', 'model', 'new', 'normalize'])
      expect(dictionary[reviewScopeKey(scope)], scope).toBeTruthy()
  })

  it('a media branch reads as media, not as its key', () => {
    expect(dictionary[reviewScopeKey('media')]).toBe('Media')
  })

  it('an unknown or missing scope reads as a plain change', () => {
    expect(reviewScopeKey('something-new')).toBe('review.scope_other')
    expect(reviewScopeKey('')).toBe('review.scope_other')
    expect(reviewScopeKey(null)).toBe('review.scope_other')
    expect(reviewScopeKey('constructor')).toBe('review.scope_other')
  })
})
