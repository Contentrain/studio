import { describe, expect, it } from 'vitest'
import { getPlanLimit, hasFeature } from '../../server/utils/license'

describe('media license features', () => {
  it('media.upload available on all plans', () => {
    expect(hasFeature('starter', 'media.upload')).toBe(true)
    expect(hasFeature('pro', 'media.upload')).toBe(true)
    expect(hasFeature('enterprise', 'media.upload')).toBe(true)
  })

  it('media.library available on all plans', () => {
    expect(hasFeature('starter', 'media.library')).toBe(true)
    expect(hasFeature('pro', 'media.library')).toBe(true)
  })

  it('gates media.custom_variants to pro+', () => {
    expect(hasFeature('starter', 'media.custom_variants')).toBe(false)
    expect(hasFeature('pro', 'media.custom_variants')).toBe(true)
    expect(hasFeature('enterprise', 'media.custom_variants')).toBe(true)
  })
})

describe('media plan limits', () => {
  it('returns correct storage limits', () => {
    expect(getPlanLimit('starter', 'media.storage_gb')).toBe(1)
    expect(getPlanLimit('pro', 'media.storage_gb')).toBe(15)
    expect(getPlanLimit('enterprise', 'media.storage_gb')).toBe(100)
  })

  it('returns correct file size limits', () => {
    expect(getPlanLimit('starter', 'media.max_file_size_mb')).toBe(5)
    expect(getPlanLimit('pro', 'media.max_file_size_mb')).toBe(50)
    expect(getPlanLimit('enterprise', 'media.max_file_size_mb')).toBe(100)
  })

  it('returns correct variant limits', () => {
    expect(getPlanLimit('starter', 'media.variants_per_field')).toBe(4)
    expect(getPlanLimit('pro', 'media.variants_per_field')).toBe(10)
    expect(getPlanLimit('enterprise', 'media.variants_per_field')).toBe(Infinity)
  })
})
