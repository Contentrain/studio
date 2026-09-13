import { describe, expect, it } from 'vitest'
import { invalidScheduleKeys, isWithinSchedule, parseScheduleTime } from '../../shared/utils/entry-schedule'

const AT = Date.parse('2026-06-15T12:00:00.000Z')

describe('entry-schedule', () => {
  it('separates absent, unreadable and readable values', () => {
    expect(parseScheduleTime(undefined)).toBeUndefined()
    expect(parseScheduleTime(null)).toBeUndefined()
    expect(parseScheduleTime('2026-06-15T12:00:00.000Z')).toBe(AT)
    for (const bad of ['', 'soon', '2026-13-45', 1750000000000, {}, []])
      expect(parseScheduleTime(bad), String(bad)).toBeNull()
  })

  it('opens the window at publish_at and closes it at expire_at', () => {
    const schedule = { publish_at: '2026-06-15T12:00:00.000Z', expire_at: '2026-06-20T12:00:00.000Z' }
    expect(isWithinSchedule(schedule, AT - 1)).toBe(false)
    expect(isWithinSchedule(schedule, AT)).toBe(true)
    expect(isWithinSchedule(schedule, Date.parse(schedule.expire_at) - 1)).toBe(true)
    expect(isWithinSchedule(schedule, Date.parse(schedule.expire_at))).toBe(false)
  })

  it('treats no schedule as always open and an unreadable one as closed', () => {
    expect(isWithinSchedule(undefined, AT)).toBe(true)
    expect(isWithinSchedule({}, AT)).toBe(true)
    expect(isWithinSchedule({ publish_at: null, expire_at: null }, AT)).toBe(true)
    expect(isWithinSchedule({ publish_at: 'soon' }, AT)).toBe(false)
    expect(isWithinSchedule({ expire_at: 'never' }, AT)).toBe(false)
  })

  it('names exactly the keys that cannot be read', () => {
    expect(invalidScheduleKeys(undefined)).toEqual([])
    expect(invalidScheduleKeys({ publish_at: '2026-06-15T12:00:00.000Z' })).toEqual([])
    expect(invalidScheduleKeys({ publish_at: 'soon' })).toEqual(['publish_at'])
    expect(invalidScheduleKeys({ publish_at: 'soon', expire_at: 'never' })).toEqual(['publish_at', 'expire_at'])
  })
})
