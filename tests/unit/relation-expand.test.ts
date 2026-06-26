import type { FieldDef } from '@contentrain/types'
import { describe, expect, it } from 'vitest'
import { brainRefEntries, expandForward, expandReverse, pickLabel } from '../../server/utils/relation-expand'
import type { ExpandModelView } from '../../server/utils/relation-expand'

describe('brainRefEntries', () => {
  it('maps a collection object-map by id', () => {
    const m = brainRefEntries({ a1: { name: 'A' } })
    expect(m.get('a1')).toEqual({ name: 'A' })
  })
  it('maps a document array by slug, exposing frontmatter', () => {
    const m = brainRefEntries([{ slug: 'intro', frontmatter: { title: 'Intro' }, body: '' }])
    expect(m.get('intro')).toEqual({ title: 'Intro' })
  })
  it('maps a collection array by id', () => {
    const m = brainRefEntries([{ id: 'x1', name: 'X' }])
    expect(m.get('x1')).toEqual({ id: 'x1', name: 'X' })
  })
})

describe('pickLabel', () => {
  it('prefers name/title/label/slug then first short string', () => {
    expect(pickLabel({ name: 'N', title: 'T' })).toBe('N')
    expect(pickLabel({ role: 'CEO' })).toBe('CEO')
    expect(pickLabel(undefined)).toBeNull()
  })
})

const blogFields: Record<string, FieldDef> = {
  author: { type: 'relation', model: 'team' } as FieldDef,
  related: { type: 'relations', model: ['blog', 'page'] } as FieldDef, // polymorphic
}

function view(modelId: string, fields: Record<string, FieldDef>, entries: Record<string, Record<string, unknown>>): ExpandModelView {
  return { modelId, fields, entries: new Map(Object.entries(entries)) }
}

describe('expandForward', () => {
  it('resolves a single + polymorphic relation to target refs with labels', () => {
    const blog = view('blog', blogFields, {
      post1: { title: 'Post 1', author: 'ahmet', related: [{ model: 'page', ref: 'about' }] },
    })
    const team = view('team', {}, { ahmet: { name: 'Ahmet' } })
    const page = view('page', {}, { about: { title: 'About' } })
    const getView = (m: string) => ({ blog, team, page } as Record<string, ExpandModelView>)[m]

    const out = expandForward(blog, 'post1', getView)
    expect(out).toEqual([
      { field: 'author', refs: [{ model: 'team', ref: 'ahmet', label: 'Ahmet' }] },
      { field: 'related', refs: [{ model: 'page', ref: 'about', label: 'About' }] },
    ])
  })

  it('returns [] for an unknown entry', () => {
    const blog = view('blog', blogFields, {})
    expect(expandForward(blog, 'ghost', () => undefined)).toEqual([])
  })
})

describe('expandReverse', () => {
  it('finds entries that reference the target', () => {
    const blog = view('blog', blogFields, {
      post1: { title: 'Post 1', author: 'ahmet' },
      post2: { title: 'Post 2', author: 'jane' },
    })
    const team = view('team', {}, { ahmet: { name: 'Ahmet' } })
    const refs = expandReverse('team', 'ahmet', [blog, team])
    expect(refs).toEqual([{ model: 'blog', ref: 'post1', field: 'author', label: 'Post 1' }])
  })

  it('matches a polymorphic compound only when the model matches', () => {
    const blog = view('blog', blogFields, {
      p1: { related: [{ model: 'page', ref: 'about' }] },
      p2: { related: [{ model: 'blog', ref: 'about' }] },
    })
    const refs = expandReverse('page', 'about', [blog])
    expect(refs).toEqual([{ model: 'blog', ref: 'p1', field: 'related', label: null }])
  })
})
