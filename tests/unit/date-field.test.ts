import { describe, expect, it } from 'vitest'
import {
  fromDateInputValue,
  fromDateTimeInputValue,
  toDateInputValue,
  toDateTimeInputValue,
} from '../../app/utils/date-field'

// These assertions are deliberately timezone-independent: `date` conversions
// read literal parts, and `datetime` is checked by round-trip rather than by a
// hardcoded local rendering, so the suite behaves the same wherever it runs.

describe('date field conversion', () => {
  it('fills the input from a stored ISO value', () => {
    // The bug: this returned the raw ISO string, which the browser rejected
    // and blanked, so a required field looked empty and saved empty.
    expect(toDateInputValue('2026-05-28T09:00:00.000Z')).toBe('2026-05-28')
  })

  it('keeps the calendar day whatever the reader offset', () => {
    // Late-evening UTC is the next day east of London. Resolving this to an
    // instant and formatting it back would move the record a day.
    expect(toDateInputValue('2026-05-28T22:00:00.000Z')).toBe('2026-05-28')
    expect(toDateInputValue('2026-05-28T01:00:00.000Z')).toBe('2026-05-28')
  })

  it('accepts a bare date and a local-naive value alike', () => {
    expect(toDateInputValue('2026-05-28')).toBe('2026-05-28')
    expect(toDateInputValue('2026-05-28T12:00')).toBe('2026-05-28')
  })

  it('writes back in the ISO shape the content already uses', () => {
    expect(fromDateInputValue('2026-05-28')).toBe('2026-05-28T00:00:00.000Z')
  })

  it('round-trips a date without drifting', () => {
    const stored = fromDateInputValue('2026-05-28')

    expect(toDateInputValue(stored)).toBe('2026-05-28')
  })

  it('treats an empty or unusable value as empty rather than Invalid Date', () => {
    expect(toDateInputValue('')).toBe('')
    expect(toDateInputValue(null)).toBe('')
    expect(toDateInputValue(undefined)).toBe('')
    expect(toDateInputValue('not a date')).toBe('')
    expect(fromDateInputValue('')).toBe('')
    expect(fromDateInputValue('not a date')).toBe('')
  })
})

describe('datetime field conversion', () => {
  it('produces the shape the input accepts', () => {
    expect(toDateTimeInputValue('2026-05-28T09:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })

  it('round-trips an instant back to the same UTC value', () => {
    const stored = '2026-05-28T09:00:00.000Z'

    expect(fromDateTimeInputValue(toDateTimeInputValue(stored))).toBe(stored)
  })

  it('normalises the input back to UTC instead of storing it naive', () => {
    // The second half of the bug: the input's output was stored verbatim, so
    // one record could hold both an ISO-UTC and a local-naive value.
    const written = fromDateTimeInputValue('2026-05-28T12:00')

    expect(written).toMatch(/Z$/)
    expect(new Date(written).getTime()).toBe(new Date('2026-05-28T12:00').getTime())
  })

  it('still loads values that were written while this was broken', () => {
    // A local-naive string means local time, so it reads back unchanged.
    expect(toDateTimeInputValue('2026-05-28T12:00')).toBe('2026-05-28T12:00')
  })

  it('drops sub-minute precision only once, not on every load', () => {
    const stored = '2026-05-28T09:00:45.500Z'
    const firstWrite = fromDateTimeInputValue(toDateTimeInputValue(stored))
    const secondWrite = fromDateTimeInputValue(toDateTimeInputValue(firstWrite))

    expect(firstWrite).toBe(secondWrite)
  })

  it('treats an empty or unusable value as empty rather than Invalid Date', () => {
    expect(toDateTimeInputValue('')).toBe('')
    expect(toDateTimeInputValue(null)).toBe('')
    expect(toDateTimeInputValue('not a date')).toBe('')
    expect(fromDateTimeInputValue('')).toBe('')
    expect(fromDateTimeInputValue('not a date')).toBe('')
  })
})
