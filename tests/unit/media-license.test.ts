import { describe, expect, it } from 'vitest'
import { getPlanLimit, hasFeature } from '../../server/utils/license'

describe('media license features', () => {
  it('gates media.upload to pro+', () => {
    expect(hasFeature('free', 'media.upload')).toBe(false)
    expect(hasFeature('pro', 'media.upload')).toBe(true)
    expect(hasFeature('business', 'media.upload')).toBe(true)
    expect(hasFeature('enterprise', 'media.upload')).toBe(true)
  })

  it('gates media.library to pro+', () => {
    expect(hasFeature('free', 'media.library')).toBe(false)
    expect(hasFeature('pro', 'media.library')).toBe(true)
  })

  it('gates media.custom_variants to business+', () => {
    expect(hasFeature('free', 'media.custom_variants')).toBe(false)
    expect(hasFeature('pro', 'media.custom_variants')).toBe(false)
    expect(hasFeature('business', 'media.custom_variants')).toBe(true)
    expect(hasFeature('enterprise', 'media.custom_variants')).toBe(true)
  })
})

describe('media plan limits', () => {
  it('returns correct storage limits', () => {
    expect(getPlanLimit('free', 'media.storage_gb')).toBe(0)
    expect(getPlanLimit('pro', 'media.storage_gb')).toBe(2)
    expect(getPlanLimit('business', 'media.storage_gb')).toBe(10)
    expect(getPlanLimit('enterprise', 'media.storage_gb')).toBe(Infinity)
  })

  it('returns correct file size limits', () => {
    expect(getPlanLimit('free', 'media.max_file_size_mb')).toBe(0)
    expect(getPlanLimit('pro', 'media.max_file_size_mb')).toBe(10)
    expect(getPlanLimit('business', 'media.max_file_size_mb')).toBe(50)
    expect(getPlanLimit('enterprise', 'media.max_file_size_mb')).toBe(100)
  })

  it('returns correct variant limits', () => {
    expect(getPlanLimit('free', 'media.variants_per_field')).toBe(0)
    expect(getPlanLimit('pro', 'media.variants_per_field')).toBe(4)
    expect(getPlanLimit('business', 'media.variants_per_field')).toBe(10)
    expect(getPlanLimit('enterprise', 'media.variants_per_field')).toBe(Infinity)
  })
})
