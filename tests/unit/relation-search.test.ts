import { describe, expect, it } from 'vitest'
import { buildRelationOptions } from '../../shared/utils/content-relations'
import { filterRelationOptions, groupRelationOptions, normalizeSearchText, relationOptionRef } from '../../shared/utils/relation-search'

const opts = [
  { value: 'e1', label: 'İstanbul Guide' },
  { value: 'e2', label: 'Şehir Rehberi' },
  { value: 'e3', label: 'Çağrı Merkezi' },
  { value: 'e4', label: 'Iğdır Notes' },
  { value: 'e5', label: 'Plain title' },
]

describe('normalizeSearchText', () => {
  it('ignores case and diacritics, Turkish dotted and dotless i included', () => {
    expect(normalizeSearchText('İSTANBUL')).toBe('istanbul')
    expect(normalizeSearchText('ISPARTA')).toBe('isparta')
    expect(normalizeSearchText('ığdır')).toBe('igdir')
    expect(normalizeSearchText('Şehir Çağrı Öğün Üzüm')).toBe('sehir cagri ogun uzum')
    expect(normalizeSearchText('Straße')).toBe('strasse')
  })

  it('collapses whitespace', () => {
    expect(normalizeSearchText('  a \t b  ')).toBe('a b')
  })
})

describe('filterRelationOptions', () => {
  it('finds a Turkish title from its plain-ASCII spelling, and the other way round', () => {
    expect(filterRelationOptions(opts, 'istanbul').items.map(o => o.value)).toEqual(['e1'])
    expect(filterRelationOptions(opts, 'SEHIR').items.map(o => o.value)).toEqual(['e2'])
    expect(filterRelationOptions(opts, 'çağrı').items.map(o => o.value)).toEqual(['e3'])
    expect(filterRelationOptions(opts, 'igdir').items.map(o => o.value)).toEqual(['e4'])
    expect(filterRelationOptions([{ value: 'x', label: 'Istanbul' }], 'İstanbul').total).toBe(1)
  })

  it('also matches the id or slug', () => {
    const withIds = [{ value: 'f3a81c09d24e', label: 'Hero slide' }, { value: 'getting-started', label: 'Intro' }]
    expect(filterRelationOptions(withIds, 'f3a81c').items).toHaveLength(1)
    expect(filterRelationOptions(withIds, 'getting-started').items[0]!.label).toBe('Intro')
  })

  it('needs every term, in any order', () => {
    expect(filterRelationOptions(opts, 'guide ist').total).toBe(1)
    expect(filterRelationOptions(opts, 'guide sehir').total).toBe(0)
  })

  it('an empty query matches everything and reports the total past the cap', () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ value: `id-${i}`, label: `Entry ${i}` }))
    const all = filterRelationOptions(many, '', 100)
    expect(all.items).toHaveLength(100)
    expect(all.total).toBe(1500)
    const narrowed = filterRelationOptions(many, 'entry 14', 100)
    expect(narrowed.total).toBe(many.filter(o => o.label.includes('14')).length)
    expect(narrowed.items).toHaveLength(100)
  })

  it('keeps the options\' own order', () => {
    expect(filterRelationOptions(opts, 'i').items.map(o => o.value)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
  })
})

describe('polymorphic options', () => {
  const posts = [{ id: 'p1', title: 'Hello' }, { id: 'p2', title: 'Şiir' }]
  const authors = [{ id: 'a1', name: 'Ada' }]
  const all = [
    ...buildRelationOptions('posts', posts, true, { fields: { title: { type: 'string' } }, title_field: 'title', name: 'Blog posts' } as never),
    ...buildRelationOptions('authors', authors, true),
  ]

  it('carry their model, its display name and the bare label', () => {
    expect(all[0]).toMatchObject({ value: 'posts::p1', group: 'posts', groupLabel: 'Blog posts', text: 'Hello', label: 'posts: Hello' })
    expect(all[2]).toMatchObject({ value: 'authors::a1', group: 'authors', groupLabel: 'authors', text: 'Ada' })
    expect(relationOptionRef(all[0]!)).toBe('p1')
  })

  it('group by model in first-seen order, and match on the model name', () => {
    expect(groupRelationOptions(all).map(g => [g.label, g.items.length])).toEqual([['Blog posts', 2], ['authors', 1]])
    expect(filterRelationOptions(all, 'blog').items.map(o => o.value)).toEqual(['posts::p1', 'posts::p2'])
    expect(filterRelationOptions(all, 'siir').items.map(o => o.value)).toEqual(['posts::p2'])
  })

  it('a plain relation is one unnamed group', () => {
    expect(groupRelationOptions(opts).map(g => g.key)).toEqual([''])
  })
})
