import { describe, expect, it } from 'vitest'
import {
  buildRelationOptions,
  findRelationLabel,
  inferFieldType,
  isPolymorphicRelation,
  relationItemKey,
  relationKeyToItem,
  toSelectableRefs,
} from '../../app/utils/content-relations'

describe('isPolymorphicRelation', () => {
  it('is only polymorphic when more than one target model is listed', () => {
    expect(isPolymorphicRelation(undefined)).toBe(false)
    expect(isPolymorphicRelation('team-members')).toBe(false)
    expect(isPolymorphicRelation(['team-members'])).toBe(false)
    expect(isPolymorphicRelation(['blog-post', 'page'])).toBe(true)
  })
})

describe('relationItemKey / relationKeyToItem', () => {
  it('passes bare refs through unchanged for single-target relations', () => {
    expect(relationItemKey('entry-1')).toBe('entry-1')
    expect(relationKeyToItem('entry-1', false)).toBe('entry-1')
  })

  it('encodes and decodes polymorphic { model, ref } compounds', () => {
    const item = { model: 'blog-post', ref: 'getting-started' }
    const key = relationItemKey(item)
    expect(key).toBe('blog-post::getting-started')
    expect(relationKeyToItem(key, true)).toEqual(item)
  })

  it('round-trips a ref that itself contains a colon', () => {
    const item = { model: 'page', ref: 'a:b:c' }
    expect(relationKeyToItem(relationItemKey(item), true)).toEqual(item)
  })

  it('is null/undefined safe', () => {
    expect(relationItemKey(null)).toBe('')
    expect(relationItemKey(undefined)).toBe('')
  })
})

describe('toSelectableRefs', () => {
  it('reads a collection object-map keyed by entry id', () => {
    const data = {
      a1b2c3d4e5f6: { name: 'Ahmet', role: 'CEO' },
      f6e5d4c3b2a1: { name: 'Jane', role: 'CTO' },
    }
    expect(toSelectableRefs(data)).toEqual([
      { ref: 'a1b2c3d4e5f6', entry: { name: 'Ahmet', role: 'CEO' } },
      { ref: 'f6e5d4c3b2a1', entry: { name: 'Jane', role: 'CTO' } },
    ])
  })

  it('reads a collection array keyed by injected id (or ID)', () => {
    const data = [
      { id: 'x1', title: 'One' },
      { ID: 'x2', title: 'Two' },
      { title: 'no id — skipped' },
    ]
    expect(toSelectableRefs(data)).toEqual([
      { ref: 'x1', entry: { id: 'x1', title: 'One' } },
      { ref: 'x2', entry: { ID: 'x2', title: 'Two' } },
    ])
  })

  it('reads a document array keyed by slug, exposing frontmatter as the entry', () => {
    const data = [
      { slug: 'getting-started', frontmatter: { title: 'Getting Started' }, body: '# hi' },
    ]
    expect(toSelectableRefs(data)).toEqual([
      { ref: 'getting-started', entry: { title: 'Getting Started' } },
    ])
  })

  it('returns an empty list for missing / non-target shapes', () => {
    expect(toSelectableRefs(null)).toEqual([])
    expect(toSelectableRefs(undefined)).toEqual([])
    expect(toSelectableRefs('nope')).toEqual([])
    expect(toSelectableRefs([null, 'x', 42])).toEqual([])
  })
})

describe('findRelationLabel', () => {
  it('prefers name → title → label → slug', () => {
    expect(findRelationLabel({ name: 'N', title: 'T' })).toBe('N')
    expect(findRelationLabel({ title: 'T', label: 'L' })).toBe('T')
    expect(findRelationLabel({ slug: 's' })).toBe('s')
  })

  it('falls back to the first short string value', () => {
    expect(findRelationLabel({ role: 'CEO' })).toBe('CEO')
  })

  it('returns null when nothing usable exists', () => {
    expect(findRelationLabel({ count: 3, active: true })).toBeNull()
    expect(findRelationLabel({ huge: 'x'.repeat(200) })).toBeNull()
  })
})

describe('buildRelationOptions', () => {
  it('builds bare-ref options for single-target relations', () => {
    const data = { id1: { name: 'Ahmet' } }
    expect(buildRelationOptions('team-members', data, false)).toEqual([
      { value: 'id1', label: 'Ahmet' },
    ])
  })

  it('encodes the target model into value + label for polymorphic relations', () => {
    const data = [{ slug: 'getting-started', frontmatter: { title: 'Getting Started' }, body: '' }]
    const [opt] = buildRelationOptions('blog-post', data, true)
    expect(opt).toEqual({ value: 'blog-post::getting-started', label: 'blog-post: Getting Started' })
    // Selecting this option round-trips to the stored { model, ref } shape.
    expect(relationKeyToItem(opt!.value, true)).toEqual({ model: 'blog-post', ref: 'getting-started' })
  })

  it('falls back to a truncated ref when no label is found', () => {
    const data = { abcdef123456: { count: 1 } }
    expect(buildRelationOptions('m', data, false)).toEqual([
      { value: 'abcdef123456', label: 'abcdef12' },
    ])
  })
})

describe('inferFieldType', () => {
  it('maps a frontmatter value to an editor field type', () => {
    expect(inferFieldType(true)).toBe('boolean')
    expect(inferFieldType(42)).toBe('number')
    expect(inferFieldType(['a', 'b'])).toBe('array')
    expect(inferFieldType({ a: 1 })).toBe('object')
    expect(inferFieldType('text')).toBe('string')
    expect(inferFieldType(null)).toBe('string')
    expect(inferFieldType(undefined)).toBe('string')
  })
})
