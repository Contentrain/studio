import { describe, expect, it } from 'vitest'
import { invalidScheduleKeys, isWithinSchedule, parseScheduleTime, schedulePhase } from '../../shared/utils/entry-schedule'

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

  it('names the phase a published entry outside its window is in, on the same boundaries delivery uses', () => {
    const before = '2026-06-15T11:59:59.999Z'
    const exact = '2026-06-15T12:00:00.000Z'
    expect(schedulePhase({ publish_at: '2030-01-01T00:00:00.000Z' }, AT)).toBe('scheduled')
    expect(schedulePhase({ publish_at: exact }, AT)).toBeNull()
    expect(schedulePhase({ expire_at: exact }, AT)).toBe('expired')
    expect(schedulePhase({ expire_at: before }, AT)).toBe('expired')
    expect(schedulePhase({ publish_at: before, expire_at: '2030-01-01T00:00:00.000Z' }, AT)).toBeNull()
    // Agrees with delivery: every phase is outside the window, null is inside it.
    for (const s of [{ publish_at: '2030-01-01T00:00:00.000Z' }, { expire_at: exact }, { publish_at: before }, {}])
      expect(schedulePhase(s, AT) === null, JSON.stringify(s)).toBe(isWithinSchedule(s, AT))
    // Unreadable is reported by invalidScheduleKeys, not guessed at here.
    expect(schedulePhase({ publish_at: 'soon' }, AT)).toBeNull()
    expect(schedulePhase(null, AT)).toBeNull()
  })
})
