import { describe, expect, it } from 'vitest'
import { isLocaleAgnosticField, localeAgnosticFieldIds } from '../../shared/utils/locale-agnostic-fields'

describe('locale-agnostic fields', () => {
  it('names media and relation fields, and nothing that reads as prose', () => {
    for (const type of ['image', 'video', 'file', 'relation', 'relations']) expect(isLocaleAgnosticField({ type })).toBe(true)
    for (const type of ['string', 'text', 'richtext', 'markdown', 'select', 'boolean', 'date', 'number', 'slug']) expect(isLocaleAgnosticField({ type })).toBe(false)
    expect(isLocaleAgnosticField(undefined)).toBe(false)
  })

  it('lists them in the model\'s own order', () => {
    expect(localeAgnosticFieldIds({
      title: { type: 'string' },
      cover: { type: 'image' },
      author: { type: 'relation' },
      body: { type: 'richtext' },
    })).toEqual(['cover', 'author'])
    expect(localeAgnosticFieldIds(null)).toEqual([])
  })
})
