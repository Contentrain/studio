import { describe, expect, it } from 'vitest'
import {
  ALLOWED_MIME_TYPES,
  DEFAULT_PRESET,
  VARIANT_PRESETS,
  isAllowedMimeType,
  resolveVariantConfig,
  resolveVariantConfigWithPlan,
} from '../../server/utils/media-variants'
import type { VariantConfig } from '../../server/providers/media'

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

describe('resolveVariantConfigWithPlan — plan gating', () => {
  const proGate = { hasCustomVariants: true, variantsPerFieldLimit: 10 }
  const starterGate = { hasCustomVariants: false, variantsPerFieldLimit: 4 }
  const unlimited = { hasCustomVariants: true, variantsPerFieldLimit: Infinity }
  const zeroLimitGate = { hasCustomVariants: false, variantsPerFieldLimit: 0 }

  it('honors preset names on any plan', () => {
    expect(resolveVariantConfigWithPlan('avatar', starterGate)).toEqual(VARIANT_PRESETS.avatar)
    expect(resolveVariantConfigWithPlan('avatar', proGate)).toEqual(VARIANT_PRESETS.avatar)
  })

  it('accepts custom variant objects when hasCustomVariants is true', () => {
    const custom: Record<string, VariantConfig> = {
      hero: { width: 1600, height: 900, fit: 'cover', quality: 80 },
    }
    expect(resolveVariantConfigWithPlan(custom, proGate)).toEqual(custom)
  })

  it('silently falls back to default preset when hasCustomVariants is false', () => {
    const custom: Record<string, VariantConfig> = {
      hero: { width: 1600, height: 900, fit: 'cover', quality: 80 },
    }
    // Starter plan submitting a custom object → gets the default preset
    // instead. We don't 403 because the upload is still useful with
    // the preset; we just refuse the customisation.
    expect(resolveVariantConfigWithPlan(custom, starterGate)).toEqual(VARIANT_PRESETS[DEFAULT_PRESET])
  })

  it('throws when resolved variant count exceeds the plan limit', () => {
    // Pro gate has custom variants enabled so the oversized object
    // survives the hasCustomVariants gate and hits the count check.
    // limit=10 so we need >10 variants to fail.
    const oversized: Record<string, VariantConfig> = {}
    for (let i = 0; i < 12; i++) oversized[`v${i}`] = { width: 100, height: 100 }
    expect(() => resolveVariantConfigWithPlan(oversized, proGate)).toThrow()
  })

  it('catches preset overflow too (default preset has 4 variants)', () => {
    const tightGate = { hasCustomVariants: true, variantsPerFieldLimit: 3 }
    expect(() => resolveVariantConfigWithPlan('hero-image', tightGate)).toThrow()
  })

  it('accepts unlimited plans — no cap applied', () => {
    const big: Record<string, VariantConfig> = {}
    for (let i = 0; i < 20; i++) {
      big[`v${i}`] = { width: 100 * i + 100, height: 100 * i + 100 }
    }
    expect(resolveVariantConfigWithPlan(big, unlimited)).toBe(big)
  })

  it('treats a zero limit as no-op (Community Edition fallback is guarded upstream)', () => {
    // Community returns 0 for `variants_per_field` via the requires_ee
    // gate. The helper must not 403 on the default preset here — the
    // endpoint-level `media.upload` check already blocks community
    // before we reach this code.
    expect(() => resolveVariantConfigWithPlan(undefined, zeroLimitGate)).not.toThrow()
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
