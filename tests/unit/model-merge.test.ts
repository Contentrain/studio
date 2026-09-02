import { describe, expect, it } from 'vitest'
import type { ModelDefinition } from '@contentrain/types'
import {
  breakingCandidates,
  describeBreakingChange,
  hasContentValue,
  mergeModelDefinition,
  summarizeModelChange,
  validateTitleField,
  withAffectedEntries,
} from '../../server/utils/content-engine/model-merge'

const homePage: ModelDefinition = {
  id: 'home-page',
  name: 'Home Page',
  kind: 'singleton',
  domain: 'marketing',
  i18n: true,
  title_field: 'hero_title',
  description: 'Landing page content',
  fields: {
    hero_title: { type: 'string', required: true },
    hero_subtitle: { type: 'text' },
    pricing_preview: { type: 'object', fields: { headline: { type: 'string' } } },
  },
}

describe('mergeModelDefinition', () => {
  it('keeps every field the caller did not send', () => {
    // The iterum payload: one image field, nothing else. It replaced 39.
    const next = mergeModelDefinition(homePage, {
      id: 'home-page',
      fields: { hero_background_image: { type: 'image', description: 'Hero banner' } },
    })

    expect(Object.keys(next.fields!).toSorted()).toEqual(['hero_background_image', 'hero_subtitle', 'hero_title', 'pricing_preview'])
    expect(next.title_field).toBe('hero_title')
    expect(next.description).toBe('Landing page content')
    expect(next.name).toBe('Home Page')
  })

  it('merges a sent field property by property, so adding a label keeps required', () => {
    const next = mergeModelDefinition(homePage, {
      id: 'home-page',
      fields: { hero_title: { type: 'string', label: 'Başlık', order: 1 } },
    })

    expect(next.fields!.hero_title).toEqual({ type: 'string', required: true, label: 'Başlık', order: 1 })
  })

  it('removes a field only when told to', () => {
    const next = mergeModelDefinition(homePage, { id: 'home-page' }, ['pricing_preview'])

    expect(next.fields!.pricing_preview).toBeUndefined()
    expect(Object.keys(next.fields!)).toHaveLength(2)
  })

  it('lets an explicit top-level value win, and ignores undefined', () => {
    const next = mergeModelDefinition(homePage, { id: 'home-page', description: 'Renamed', title_field: undefined })

    expect(next.description).toBe('Renamed')
    expect(next.title_field).toBe('hero_title')
  })

  it('carries Studio-only keys such as a form config through a fields-only save', () => {
    const withForm = { ...homePage, form: { enabled: true, exposedFields: ['hero_title'] } } as ModelDefinition
    const next = mergeModelDefinition(withForm, { id: 'home-page', fields: { extra: { type: 'string' } } })

    expect((next as { form?: unknown }).form).toEqual({ enabled: true, exposedFields: ['hero_title'] })
  })

  it('drops fields altogether when the model becomes a dictionary', () => {
    const next = mergeModelDefinition(homePage, { id: 'home-page', kind: 'dictionary', title_field: 'key' })

    expect(next.fields).toBeUndefined()
  })
})

describe('summarizeModelChange', () => {
  it('says exactly what a save did to the field list', () => {
    const next = mergeModelDefinition(homePage, {
      id: 'home-page',
      fields: { hero_background_image: { type: 'image' }, hero_subtitle: { type: 'text', label: 'Alt başlık' } },
    }, ['pricing_preview'])

    expect(summarizeModelChange(homePage, next)).toEqual({
      action: 'updated',
      addedFields: ['hero_background_image'],
      changedFields: ['hero_subtitle'],
      removedFields: ['pricing_preview'],
      keptFields: 1,
    })
  })

  it('reports a new model as created with every field added', () => {
    expect(summarizeModelChange(null, homePage)).toMatchObject({ action: 'created', addedFields: ['hero_subtitle', 'hero_title', 'pricing_preview'], keptFields: 0 })
  })
})

describe('breaking changes', () => {
  it('lists a removed or retyped field, a changed kind and a changed i18n as candidates', () => {
    const next: ModelDefinition = {
      ...homePage,
      kind: 'collection',
      i18n: false,
      fields: { hero_title: { type: 'richtext', required: true }, hero_subtitle: { type: 'text' } },
    }

    expect(breakingCandidates(homePage, next)).toEqual([
      { kind: 'kind_changed', from: 'singleton', to: 'collection' },
      { kind: 'i18n_changed', from: 'true', to: 'false' },
      { kind: 'field_type_changed', field: 'hero_title', from: 'string', to: 'richtext' },
      { kind: 'field_removed', field: 'pricing_preview', from: 'object' },
    ])
  })

  it('finds nothing to refuse in an additive save', () => {
    const next = mergeModelDefinition(homePage, { id: 'home-page', fields: { hero_background_image: { type: 'image' } } })
    expect(breakingCandidates(homePage, next)).toEqual([])
  })

  it('keeps only the candidates that have content behind them', () => {
    const candidates = breakingCandidates(homePage, mergeModelDefinition(homePage, { id: 'home-page' }, ['pricing_preview', 'hero_subtitle']))
    const usage = { entries: 3, byField: { pricing_preview: 3 } }

    expect(withAffectedEntries(candidates, usage)).toEqual([
      { kind: 'field_removed', field: 'pricing_preview', from: 'object', affectedEntries: 3 },
    ])
  })

  it('counts a kind or i18n change against every entry', () => {
    const candidates = breakingCandidates(homePage, { ...homePage, i18n: false })
    expect(withAffectedEntries(candidates, { entries: 2, byField: {} })).toEqual([
      { kind: 'i18n_changed', from: 'true', to: 'false', affectedEntries: 2 },
    ])
    expect(withAffectedEntries(candidates, { entries: 0, byField: {} })).toEqual([])
  })

  it('names the field and the count in the refusal', () => {
    expect(describeBreakingChange({ kind: 'field_removed', field: 'pricing_preview', from: 'object', affectedEntries: 1 }))
      .toBe('Field "pricing_preview" is still used by 1 entry; removing it would orphan that content. Clear it from those entries first, or confirm the removal explicitly (allow_breaking).')
    expect(describeBreakingChange({ kind: 'field_type_changed', field: 'count', from: 'string', to: 'integer', affectedEntries: 4 }))
      .toContain('4 entries; changing its type from "string" to "integer"')
  })
})

describe('hasContentValue', () => {
  it('treats null, empty string, empty array and empty object as nothing', () => {
    for (const empty of [null, undefined, '', [], {}]) expect(hasContentValue(empty)).toBe(false)
    for (const value of [0, false, 'x', [1], { a: 1 }]) expect(hasContentValue(value)).toBe(true)
  })
})

describe('validateTitleField', () => {
  it('accepts an absent title field, a text field, and "key" on a dictionary', () => {
    expect(validateTitleField({ ...homePage, title_field: undefined as unknown as string })).toBeNull()
    expect(validateTitleField(homePage)).toBeNull()
    expect(validateTitleField({ id: 'ui', name: 'UI', kind: 'dictionary', domain: 'system', i18n: true, title_field: 'key' })).toBeNull()
  })

  it('refuses a field that does not exist or cannot render as text', () => {
    expect(validateTitleField({ ...homePage, title_field: 'nope' })).toContain('does not name a field')
    expect(validateTitleField({ ...homePage, title_field: 'pricing_preview' })).toContain('has type "object"')
    expect(validateTitleField({ id: 'ui', name: 'UI', kind: 'dictionary', domain: 'system', i18n: true, title_field: 'title' })).toContain('must be "key"')
  })
})
