import { describe, expect, it } from 'vitest'
import {
  canRenderMediaValue,
  isStoredAssetPath,
  readableMediaName,
} from '../../app/utils/media-display'

describe('readableMediaName', () => {
  it('collapses a storage UUID to its kind and a short id', () => {
    // The reported case: a 32px thumbnail next to 36 characters of nothing.
    expect(readableMediaName('media/8d2ed576-57e5-4cab-8f57-bfe52d56ddff.webp'))
      .toBe('WEBP · 8d2ed576')
  })

  it('leaves a real filename alone', () => {
    // A name someone chose is the best label available — do not improve it.
    expect(readableMediaName('media/cover.webp')).toBe('cover.webp')
    expect(readableMediaName('https://cdn.example.com/photos/team-offsite-2026.jpg'))
      .toBe('team-offsite-2026.jpg')
  })

  it('drops a query string and a fragment before naming', () => {
    expect(readableMediaName('media/cover.webp?w=320&format=webp')).toBe('cover.webp')
    expect(readableMediaName('media/8d2ed576-57e5-4cab-8f57-bfe52d56ddff.png#x')).toBe('PNG · 8d2ed576')
  })

  it('handles a UUID with no extension', () => {
    expect(readableMediaName('media/8d2ed576-57e5-4cab-8f57-bfe52d56ddff')).toBe('8d2ed576')
  })

  it('is not fooled by a hyphenated name that merely looks id-ish', () => {
    expect(readableMediaName('media/hero-2026-01-01-final.webp')).toBe('hero-2026-01-01-final.webp')
  })

  it('returns the value itself when there is no path to speak of', () => {
    expect(readableMediaName('logo.svg')).toBe('logo.svg')
    expect(readableMediaName('')).toBe('')
  })
})

describe('isStoredAssetPath', () => {
  it('recognises what Studio stored, and only that', () => {
    // The distinction matters because only a stored asset failing to load is
    // Studio's fault — anything else failing is not an error to report as one.
    expect(isStoredAssetPath('media/cover.webp')).toBe(true)
    expect(isStoredAssetPath('https://cdn.example.com/cover.webp')).toBe(false)
    expect(isStoredAssetPath('/public/cover.webp')).toBe(false)
    expect(isStoredAssetPath('asset:1234')).toBe(false)
    expect(isStoredAssetPath('')).toBe(false)
  })

  it('does not match a path that merely contains the segment', () => {
    expect(isStoredAssetPath('uploads/media/cover.webp')).toBe(false)
  })
})

describe('canRenderMediaValue', () => {
  it('accepts anything a browser could actually fetch', () => {
    expect(canRenderMediaValue('media/cover.webp')).toBe(true)
    expect(canRenderMediaValue('https://cdn.example.com/cover.webp')).toBe(true)
    expect(canRenderMediaValue('//cdn.example.com/cover.webp')).toBe(true)
    expect(canRenderMediaValue('/images/cover.webp')).toBe(true)
  })

  it('refuses a reference that is not a location', () => {
    // These used to be rendered anyway, 404, and show as broken media — which
    // read as "the asset is corrupt" for a value Studio never held.
    expect(canRenderMediaValue('asset:1234')).toBe(false)
    expect(canRenderMediaValue('hero-image')).toBe(false)
    expect(canRenderMediaValue('')).toBe(false)
  })
})
