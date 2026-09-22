import { describe, expect, it } from 'vitest'
import { usableTreeSha } from '../../shared/utils/tree-sha'

/**
 * The client's half of the brain cache key contract. The server's half — that
 * what it mints is always a fixed-length digest — is in brain-cache.test.ts.
 */
describe('usableTreeSha', () => {
  const digest = 'a'.repeat(64)

  it('sends back a token this build minted', () => {
    expect(usableTreeSha(digest)).toBe(digest)
  })

  it('declines the pre-hash token instead of sending it', () => {
    // What a browser that used Studio before the hash still holds: the whole
    // `path:sha|…` join. Measured on staging at 4,404 characters for 54 files.
    // Sending it back earns a 431 on any sizeable project, which lands the sync
    // in its catch — and the catch never replaces the stored token, so the
    // browser would fail again on every load, forever. One full sync instead.
    const legacy = Array.from(
      { length: 54 },
      (_, i) => `.contentrain/content/m${i}/en.json:${'b'.repeat(40)}`,
    ).join('|')

    // Thousands of characters at 54 files, and it grows from there — the shape
    // is what matters, these synthetic paths are a little shorter than real ones.
    expect(legacy.length).toBeGreaterThan(3000)
    expect(usableTreeSha(legacy)).toBeNull()
  })

  it('declines anything that is not a token', () => {
    expect(usableTreeSha(null)).toBeNull()
    expect(usableTreeSha(undefined)).toBeNull()
    expect(usableTreeSha('')).toBeNull()
    // A 40-char Git object SHA is the shape someone would reach for by
    // reflex; it is not what this endpoint mints.
    expect(usableTreeSha('c'.repeat(40))).toBeNull()
    expect(usableTreeSha(`${digest}extra`)).toBeNull()
    expect(usableTreeSha(digest.toUpperCase())).toBeNull()
  })
})
