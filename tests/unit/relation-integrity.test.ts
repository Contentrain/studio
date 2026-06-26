import type { FieldDef } from '@contentrain/types'
import { describe, expect, it } from 'vitest'
import { brainContentRefs, findBrokenRelations } from '../../server/utils/relation-integrity'

describe('brainContentRefs', () => {
  it('reads a collection object-map keyed by id', () => {
    expect(brainContentRefs({ a1: { name: 'A' }, b2: { name: 'B' } })).toEqual(new Set(['a1', 'b2']))
  })

  it('reads a collection array keyed by id/ID', () => {
    expect(brainContentRefs([{ id: 'x1' }, { ID: 'x2' }, { noId: true }])).toEqual(new Set(['x1', 'x2']))
  })

  it('reads a document array keyed by slug', () => {
    expect(brainContentRefs([{ slug: 'getting-started', frontmatter: {}, body: '' }])).toEqual(new Set(['getting-started']))
  })

  it('is empty for missing / non-target shapes', () => {
    expect(brainContentRefs(null)).toEqual(new Set())
    expect(brainContentRefs(undefined)).toEqual(new Set())
    expect(brainContentRefs('nope')).toEqual(new Set())
  })
})

describe('findBrokenRelations', () => {
  const fields: Record<string, FieldDef> = {
    author: { type: 'relation', model: 'team-members' } as FieldDef,
    tags: { type: 'relations', model: 'tags' } as FieldDef,
    related: { type: 'relations', model: ['blog-post', 'page'] } as FieldDef, // polymorphic
    title: { type: 'string' } as FieldDef,
  }
  const refs: Record<string, Set<string>> = {
    'team-members': new Set(['ahmet', 'jane']),
    'tags': new Set(['t1', 't2']),
    'blog-post': new Set(['intro']),
    'page': new Set(['about']),
  }
  const getRefs = (m: string) => refs[m] ?? new Set<string>()

  it('passes when all single + array refs exist', () => {
    expect(findBrokenRelations({ author: 'ahmet', tags: ['t1', 't2'] }, fields, getRefs)).toEqual([])
  })

  it('flags a single relation pointing at a non-existent target', () => {
    const errs = findBrokenRelations({ author: 'ghost' }, fields, getRefs)
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('author')
    expect(errs[0]).toContain('ghost')
  })

  it('flags a broken entry inside a relations array', () => {
    const errs = findBrokenRelations({ tags: ['t1', 'nope'] }, fields, getRefs)
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('nope')
  })

  it('validates polymorphic { model, ref } against the named target', () => {
    expect(findBrokenRelations({ related: [{ model: 'blog-post', ref: 'intro' }] }, fields, getRefs)).toEqual([])
    const errs = findBrokenRelations({ related: [{ model: 'page', ref: 'missing' }] }, fields, getRefs)
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('page')
  })

  it('accepts a bare ref into a polymorphic field if it exists in any target', () => {
    expect(findBrokenRelations({ related: ['about'] }, fields, getRefs)).toEqual([]) // exists in "page"
    expect(findBrokenRelations({ related: ['nowhere'] }, fields, getRefs)).toHaveLength(1)
  })

  it('skips empty / unset relation values and non-relation fields', () => {
    expect(findBrokenRelations({ author: '', tags: [], title: 'anything' }, fields, getRefs)).toEqual([])
    expect(findBrokenRelations({ title: 'no relations here' }, fields, getRefs)).toEqual([])
  })
})
