import { describe, expect, it } from 'vitest'
import {
  DICTIONARY_TITLE_FIELD,
  resolveEntryTitle,
  resolveTitleFieldId,
  titleFieldDef,
  titleFieldOptions,
  titleFieldValue,
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

describe('resolveTitleFieldId — the same chain MCP backfills with', () => {
  it('titles authors by the required name, not the optional job title', () => {
    // The ai #120 case: name-likeness used to outrank requiredness, so the CLI
    // backfilled `title` and every author row read as "Senior Editor".
    expect(resolveTitleFieldId({
      kind: 'collection',
      fields: {
        title: { type: 'string' },
        name: { type: 'string', required: true },
      },
    })).toBe('name')
  })

  it('reads a name-like token inside a longer key', () => {
    expect(resolveTitleFieldId({
      kind: 'collection',
      fields: { post_title: { type: 'string' }, body: { type: 'richtext' } },
    })).toBe('post_title')
  })

  it('among required prose fields prefers the shorter scalar type', () => {
    expect(resolveTitleFieldId({
      kind: 'collection',
      fields: { body: { type: 'text', required: true }, summary: { type: 'string', required: true } },
    })).toBe('summary')
  })

  it('never infers a url, which is how a settings singleton was titled by WhatsApp', () => {
    expect(resolveTitleFieldId({
      kind: 'singleton',
      fields: { whatsapp_url: { type: 'url' }, tagline: { type: 'text' } },
    })).toBe('tagline')
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

// A page singleton built from sections holds only section objects at the top;
// its title is a section's heading, named by a dotted path (MCP validates the same rule).
const aboutPage = {
  kind: 'singleton',
  title_field: 'hero.heading',
  fields: {
    hero: { type: 'object', required: true, fields: { heading: { type: 'string', required: true }, image: { type: 'image' } } },
    story: { type: 'object', fields: { heading: { type: 'string' }, body: { type: 'markdown' } } },
    work: { type: 'array', items: { type: 'object', fields: { caption: { type: 'string' } } } },
  },
}

describe('title_field — a dotted path into a section object', () => {
  it('resolves one level into an object field, and nothing deeper or through an array', () => {
    expect(titleFieldDef(aboutPage, 'hero.heading')).toEqual({ type: 'string', required: true })
    expect(titleFieldDef(aboutPage, 'hero.title')).toBeUndefined()
    expect(titleFieldDef(aboutPage, 'work.caption')).toBeUndefined()
    expect(titleFieldDef(aboutPage, 'hero.heading.text')).toBeUndefined()
    expect(titleFieldDef(aboutPage, 'toString')).toBeUndefined()
  })

  it('keeps the declared path', () => {
    expect(resolveTitleFieldId(aboutPage)).toBe('hero.heading')
  })

  it('ignores a declared path that does not resolve', () => {
    expect(resolveTitleFieldId({ ...aboutPage, title_field: 'work.caption' })).not.toBe('work.caption')
  })

  it('reads the entry title at the path', () => {
    const entry = { hero: { heading: 'We build calm software' }, story: { heading: 'How we work' } }
    expect(titleFieldValue(entry, 'hero.heading')).toBe('We build calm software')
    expect(titleFieldValue({ hero: null }, 'hero.heading')).toBeUndefined()
    expect(resolveEntryTitle(entry, aboutPage, 'About')).toBe('We build calm software')
    expect(resolveEntryTitle({ hero: {} }, aboutPage, 'About')).toBe('About')
  })

  it('offers text fields inside objects after the top-level ones', () => {
    expect(titleFieldOptions({ fields: { label: { type: 'string' }, ...aboutPage.fields } })).toEqual(['label', 'hero.heading', 'story.heading', 'story.body'])
  })
})
