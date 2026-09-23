import { describe, expect, it } from 'vitest'
import { isTrialOver, TRIAL_END_TOLERANCE_MS } from '../../shared/utils/trial-end'

describe('isTrialOver', () => {
  const end = '2026-09-29T07:36:51.653Z'
  const endMs = new Date(end).getTime()

  it('is not over before the end, nor within the tolerance after it', () => {
    expect(isTrialOver(end, endMs - 1000)).toBe(false)
    expect(isTrialOver(end, endMs)).toBe(false)
    expect(isTrialOver(end, endMs + TRIAL_END_TOLERANCE_MS - 1)).toBe(false)
  })

  it('is over once the tolerance has passed', () => {
    expect(isTrialOver(end, endMs + TRIAL_END_TOLERANCE_MS)).toBe(true)
  })

  it('treats a missing or unreadable end as not over (the status decides)', () => {
    expect(isTrialOver(null, Date.now())).toBe(false)
    expect(isTrialOver('not a date', Date.now())).toBe(false)
  })
})
