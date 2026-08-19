import { describe, expect, it } from 'vitest'
import {
  DICTIONARY_TITLE_FIELD,
  resolveEntryTitle,
  resolveTitleFieldId,
  titleFieldOptions,
} from '../../shared/utils/entry-title'

// The three reported cases, as models.
const integrationGroups = {
  kind: 'collection',
  title_field: 'title',
  fields: {
    description: { type: 'text' },
    icon: { type: 'icon' },
    title: { type: 'string', required: true },
  },
}

const article = {
  kind: 'collection',
  title_field: 'title',
  fields: {
    slug: { type: 'slug', required: true, unique: true },
    title: { type: 'string', required: true },
    body: { type: 'markdown' },
  },
}

describe('resolveTitleFieldId — what the model declares', () => {
  it('uses the declared field', () => {
    expect(resolveTitleFieldId(integrationGroups)).toBe('title')
  })

  it('ignores a declaration naming a field the model does not have', () => {
    // A hand-edited model should not take the listing down with it.
    const broken = { ...article, title_field: 'nope' }
    expect(resolveTitleFieldId(broken)).toBe('title')
  })

  it('accepts `key` for a dictionary, which declares no fields', () => {
    expect(resolveTitleFieldId({ kind: 'dictionary', title_field: 'key', fields: {} }))
      .toBe(DICTIONARY_TITLE_FIELD)
  })
})

describe('resolveTitleFieldId — the fallback, for models that predate the field', () => {
  it('prefers a name-like key', () => {
    expect(resolveTitleFieldId({
      kind: 'collection',
      fields: { description: { type: 'text' }, name: { type: 'string' } },
    })).toBe('name')
  })

  it('does not pick a slug over nothing else — that is how articles listed by slug', () => {
    // The old order ranked `slug` alongside `string`, and `slug` sorts first.
    expect(resolveTitleFieldId({
      kind: 'collection',
      fields: {
        slug: { type: 'slug', required: true },
        headline: { type: 'string', required: true },
      },
    })).toBe('headline')
  })

  it('does not pick an icon, which is how a group got titled `i-lucide-bot`', () => {
    expect(resolveTitleFieldId({
      kind: 'collection',
      fields: {
        icon: { type: 'icon', required: true },
        summary: { type: 'text' },
      },
    })).toBe('summary')
  })

  it('prefers a required text field over an optional one', () => {
    expect(resolveTitleFieldId({
      kind: 'collection',
      fields: {
        aside: { type: 'string' },
        subject: { type: 'string', required: true },
      },
    })).toBe('subject')
  })

  it('falls back to the first field rather than rendering nothing', () => {
    expect(resolveTitleFieldId({
      kind: 'collection',
      fields: { colour: { type: 'color' }, shade: { type: 'color' } },
    })).toBe('colour')
  })

  it('returns null for a model with no fields at all', () => {
    expect(resolveTitleFieldId({ kind: 'collection', fields: {} })).toBeNull()
    expect(resolveTitleFieldId(null)).toBeNull()
  })
})

describe('titleFieldOptions — what the picker may offer', () => {
  it('offers only field types that can render as text', () => {
    // `icon` and `color` store strings, which is exactly why the rule is by
    // meaning rather than by `typeof`.
    expect(titleFieldOptions(integrationGroups)).toEqual(['description', 'title'])
  })

  it('offers a dictionary only its reserved key', () => {
    expect(titleFieldOptions({ kind: 'dictionary', fields: {} })).toEqual(['key'])
  })

  it('offers nothing when no field can hold a title', () => {
    expect(titleFieldOptions({ kind: 'collection', fields: { hue: { type: 'color' } } })).toEqual([])
  })
})

describe('resolveEntryTitle', () => {
  it('reads the declared field', () => {
    expect(resolveEntryTitle(
      { icon: 'i-lucide-bot', description: 'Long description…', title: 'AI Agents' },
      integrationGroups,
      'fallback',
    )).toBe('AI Agents')
  })

  it('skips the declared field when the entry leaves it empty', () => {
    expect(resolveEntryTitle({ title: '', description: 'Something' }, integrationGroups, 'fallback'))
      .toBe('Something')
  })

  it('falls back to the entry\'s own short string before the caller\'s fallback', () => {
    expect(resolveEntryTitle({ note: 'A short note' }, null, 'f3a81c09d24e')).toBe('A short note')
  })

  it('will not use a long body as a title', () => {
    expect(resolveEntryTitle({ body: 'x'.repeat(200) }, null, 'f3a81c09d24e')).toBe('f3a81c09d24e')
  })

  it('returns the fallback for an absent entry', () => {
    expect(resolveEntryTitle(null, integrationGroups, 'fallback')).toBe('fallback')
  })
})
