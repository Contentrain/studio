import { describe, expect, it } from 'vitest'
import {
  BOOLEAN_FALSE,
  BOOLEAN_TRUE,
  SORT_DEFAULT,
  SORT_STATUS,
  SORT_TITLE_ASC,
  SORT_TITLE_DESC,
  SORT_UPDATED_DESC,
  STATUS_AXIS_ID,
  applyFilters,
  deriveFilterAxes,
  deriveSortOptions,
  humanizeFieldId,
  relationRefs,
  sortIds,
} from '../../app/utils/content-filters'

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${Object.values(params).join(',')}` : key

/** Studio's own model, named by the brief as the case to get right. */
const planFeatures = {
  kind: 'collection',
  title_field: 'name',
  fields: {
    name: { type: 'string', required: true },
    category: { type: 'select', options: ['ai', 'cdn', 'media', 'forms', 'api', 'workflow', 'roles', 'enterprise'] },
    type: { type: 'select', options: ['limit', 'boolean'] },
    requires_ee: { type: 'boolean' },
    sort_order: { type: 'integer' },
  },
}

const content = {
  a: { name: 'CDN keys', category: 'cdn', type: 'limit', requires_ee: true, sort_order: 2 },
  b: { name: 'AI chat', category: 'ai', type: 'boolean', requires_ee: false, sort_order: 1 },
  c: { name: 'Media library', category: 'media', type: 'boolean', requires_ee: true, sort_order: 3 },
}

const meta = {
  a: { status: 'published', updated_at: '2026-08-01T00:00:00.000Z' },
  b: { status: 'draft' },
  c: { status: 'published', updated_at: '2026-08-10T00:00:00.000Z' },
}

describe('deriveFilterAxes', () => {
  it('produces the axes the brief names for plan-features', () => {
    const axes = deriveFilterAxes({ model: planFeatures, content, meta, t })

    expect(axes.map(a => a.id)).toEqual([STATUS_AXIS_ID, 'category', 'type', 'requires_ee'])
    expect(axes.find(a => a.id === 'category')!.options).toHaveLength(8)
    expect(axes.find(a => a.id === 'type')!.options).toHaveLength(2)
  })

  it('takes select options straight from the schema, not from the data', () => {
    // Only three categories appear in the content above; the schema declares
    // eight, and the schema is the thing that is actually complete.
    const category = deriveFilterAxes({ model: planFeatures, content, meta, t })
      .find(a => a.id === 'category')!
    expect(category.options.map(o => o.value)).toContain('enterprise')
  })

  it('offers status without any schema at all', () => {
    const axes = deriveFilterAxes({ model: { kind: 'collection', fields: {} }, content, meta, t })
    expect(axes).toHaveLength(1)
    expect(axes[0]!.id).toBe(STATUS_AXIS_ID)
  })

  it('drops status when every entry shares one — a control that can do nothing', () => {
    const axes = deriveFilterAxes({
      model: { kind: 'collection', fields: {} },
      content,
      meta: { a: { status: 'published' }, b: { status: 'published' }, c: { status: 'published' } },
      t,
    })
    expect(axes).toHaveLength(0)
  })

  it('shows no axes rather than an empty toolbar for a model with nothing to filter', () => {
    const axes = deriveFilterAxes({
      model: { kind: 'collection', fields: { body: { type: 'markdown' } } },
      content: { a: { body: 'x' } },
      meta: { a: { status: 'draft' } },
      t,
    })
    expect(axes).toEqual([])
  })

  it('labels relation options by title, and skips the axis without labels', () => {
    const model = {
      kind: 'collection',
      fields: { author: { type: 'relation', model: 'authors' } },
    }
    const rows = { a: { author: 'u1' }, b: { author: 'u2' } }

    // No labels supplied — the axis would list raw ids, so it is not offered.
    expect(deriveFilterAxes({ model, content: rows, meta: null, t })).toEqual([])

    const axes = deriveFilterAxes({
      model,
      content: rows,
      meta: null,
      relationLabels: { author: { u1: 'Ahmet', u2: 'Jane' } },
      t,
    })
    expect(axes[0]!.options).toEqual([
      { value: 'u1', label: 'Ahmet' },
      { value: 'u2', label: 'Jane' },
    ])
  })

  it('reads a field id as a label', () => {
    expect(humanizeFieldId('is_category_hero')).toBe('Is category hero')
    expect(humanizeFieldId('sort-order')).toBe('Sort order')
  })
})

describe('relationRefs', () => {
  it('reads both storage shapes', () => {
    expect(relationRefs('id1')).toEqual(['id1'])
    expect(relationRefs({ model: 'blog', ref: 'getting-started' })).toEqual(['getting-started'])
    expect(relationRefs(['a', 'b'])).toEqual(['a', 'b'])
    expect(relationRefs([{ model: 'm', ref: 'r' }])).toEqual(['r'])
    expect(relationRefs(null)).toEqual([])
    expect(relationRefs('')).toEqual([])
  })
})

describe('applyFilters', () => {
  const axes = deriveFilterAxes({ model: planFeatures, content, meta, t })
  const ids = ['a', 'b', 'c']

  it('returns everything when nothing is selected', () => {
    expect(applyFilters(ids, content, meta, axes, {})).toEqual(ids)
  })

  it('ORs within an axis', () => {
    expect(applyFilters(ids, content, meta, axes, { category: ['cdn', 'ai'] })).toEqual(['a', 'b'])
  })

  it('ANDs across axes', () => {
    // "category is cdn or media, AND status is published" — b is draft.
    expect(applyFilters(ids, content, meta, axes, {
      category: ['cdn', 'media'],
      [STATUS_AXIS_ID]: ['published'],
    })).toEqual(['a', 'c'])
  })

  it('treats a boolean axis as three-state', () => {
    expect(applyFilters(ids, content, meta, axes, { requires_ee: [BOOLEAN_TRUE] })).toEqual(['a', 'c'])
    expect(applyFilters(ids, content, meta, axes, { requires_ee: [BOOLEAN_FALSE] })).toEqual(['b'])
    // Both selected is the same as neither — everything.
    expect(applyFilters(ids, content, meta, axes, { requires_ee: [BOOLEAN_TRUE, BOOLEAN_FALSE] })).toEqual(ids)
  })

  it('filters the ids it is given, so search and filter intersect', () => {
    // Search narrowed to a and b; the filter must not reintroduce c.
    expect(applyFilters(['a', 'b'], content, meta, axes, { [STATUS_AXIS_ID]: ['published'] }))
      .toEqual(['a'])
  })

  it('treats a missing status as draft, matching what the list displays', () => {
    expect(applyFilters(ids, content, {}, axes, { [STATUS_AXIS_ID]: ['draft'] })).toEqual(ids)
  })
})

describe('deriveSortOptions', () => {
  it('offers recently-updated only when the data can answer it', () => {
    // `updated_at` is not backfilled, so a project whose entries all predate it
    // would get a criterion that sorts nothing.
    const withStamps = deriveSortOptions({ model: planFeatures, meta, hasStatusAxis: true, t })
    expect(withStamps.map(o => o.value)).toContain(SORT_UPDATED_DESC)

    const without = deriveSortOptions({
      model: planFeatures,
      meta: { a: { status: 'draft' } },
      hasStatusAxis: true,
      t,
    })
    expect(without.map(o => o.value)).not.toContain(SORT_UPDATED_DESC)
  })

  it('offers status only when status is filterable at all', () => {
    expect(deriveSortOptions({ model: planFeatures, meta, hasStatusAxis: false, t }).map(o => o.value))
      .not.toContain(SORT_STATUS)
  })

  it('offers both directions for each orderable field', () => {
    const values = deriveSortOptions({ model: planFeatures, meta, hasStatusAxis: true, t }).map(o => o.value)
    expect(values).toContain('sort_order:asc')
    expect(values).toContain('sort_order:desc')
    // A select is not an ordering.
    expect(values).not.toContain('category:asc')
  })

  it('always leads with the file order', () => {
    expect(deriveSortOptions({ model: null, meta: null, hasStatusAxis: false, t })[0]!.value)
      .toBe(SORT_DEFAULT)
  })
})

describe('sortIds', () => {
  const ids = ['a', 'b', 'c']

  it('leaves the file order alone by default', () => {
    expect(sortIds(ids, content, meta, SORT_DEFAULT, planFeatures)).toEqual(ids)
  })

  it('sorts by the title the model declares, not by the first field', () => {
    expect(sortIds(ids, content, meta, SORT_TITLE_ASC, planFeatures)).toEqual(['b', 'a', 'c'])
    expect(sortIds(ids, content, meta, SORT_TITLE_DESC, planFeatures)).toEqual(['c', 'a', 'b'])
  })

  it('puts published before draft', () => {
    expect(sortIds(ids, content, meta, SORT_STATUS, planFeatures)).toEqual(['a', 'c', 'b'])
  })

  it('sorts most recently updated first, unknown last', () => {
    // `b` has no `updated_at`; absent means unknown, and unknown does not sort
    // to the top of "most recent".
    expect(sortIds(ids, content, meta, SORT_UPDATED_DESC, planFeatures)).toEqual(['c', 'a', 'b'])
  })

  it('sorts a numeric field both ways', () => {
    expect(sortIds(ids, content, meta, 'sort_order:asc', planFeatures)).toEqual(['b', 'a', 'c'])
    expect(sortIds(ids, content, meta, 'sort_order:desc', planFeatures)).toEqual(['c', 'a', 'b'])
  })

  it('keeps a missing value last in BOTH directions', () => {
    // Reversing the sort must not promote "unknown" to the top.
    const withGap = { ...content, b: { name: 'AI chat' } }
    expect(sortIds(ids, withGap, meta, 'sort_order:asc', planFeatures).at(-1)).toBe('b')
    expect(sortIds(ids, withGap, meta, 'sort_order:desc', planFeatures).at(-1)).toBe('b')
  })

  it('does not mutate the ids it was given', () => {
    const input = ['a', 'b', 'c']
    sortIds(input, content, meta, SORT_TITLE_ASC, planFeatures)
    expect(input).toEqual(['a', 'b', 'c'])
  })
})
