import { describe, expect, it } from 'vitest'
import {
  ALLOWED_MIME_TYPES,
  DEFAULT_PRESET,
  VARIANT_PRESETS,
  isAllowedMimeType,
  resolveVariantConfig,
} from '../../server/utils/media-variants'

describe('media variant presets', () => {
  it('has all expected presets', () => {
    expect(Object.keys(VARIANT_PRESETS)).toEqual(
      expect.arrayContaining(['hero-image', 'avatar', 'gallery', 'icon', 'logo']),
    )
  })

  it('hero-image preset has correct variant names', () => {
    const heroPreset = VARIANT_PRESETS['hero-image']!
    expect(Object.keys(heroPreset)).toEqual(['hero', 'card', 'thumb', 'og'])
    expect(heroPreset.hero.width).toBe(1920)
    expect(heroPreset.hero.height).toBe(1080)
    expect(heroPreset.og.format).toBe('jpeg')
  })

  it('avatar preset has square dimensions', () => {
    const avatarPreset = VARIANT_PRESETS['avatar']!
    for (const variant of Object.values(avatarPreset)) {
      expect(variant.width).toBe(variant.height)
    }
  })
})

describe('resolveVariantConfig', () => {
  it('returns default preset when undefined', () => {
    const result = resolveVariantConfig(undefined)
    expect(result).toEqual(VARIANT_PRESETS[DEFAULT_PRESET])
  })

  it('resolves string preset name', () => {
    const result = resolveVariantConfig('avatar')
    expect(result).toEqual(VARIANT_PRESETS['avatar'])
  })

  it('falls back to default for unknown preset', () => {
    const result = resolveVariantConfig('nonexistent')
    expect(result).toEqual(VARIANT_PRESETS[DEFAULT_PRESET])
  })

  it('passes through custom config object', () => {
    const custom = { thumb: { width: 100, height: 100, fit: 'cover' as const } }
    const result = resolveVariantConfig(custom)
    expect(result).toBe(custom)
  })
})

describe('MIME type validation', () => {
  it('allows standard image types', () => {
    expect(isAllowedMimeType('image/jpeg')).toBe(true)
    expect(isAllowedMimeType('image/png')).toBe(true)
    expect(isAllowedMimeType('image/webp')).toBe(true)
    expect(isAllowedMimeType('image/gif')).toBe(true)
    expect(isAllowedMimeType('image/avif')).toBe(true)
    expect(isAllowedMimeType('image/svg+xml')).toBe(true)
  })

  it('allows video and PDF', () => {
    expect(isAllowedMimeType('video/mp4')).toBe(true)
    expect(isAllowedMimeType('video/webm')).toBe(true)
    expect(isAllowedMimeType('application/pdf')).toBe(true)
  })

  it('rejects disallowed types', () => {
    expect(isAllowedMimeType('text/html')).toBe(false)
    expect(isAllowedMimeType('application/javascript')).toBe(false)
    expect(isAllowedMimeType('application/zip')).toBe(false)
    expect(isAllowedMimeType('image/bmp')).toBe(false)
  })

  it('has expected count of allowed types', () => {
    expect(ALLOWED_MIME_TYPES.size).toBe(9)
  })
})
