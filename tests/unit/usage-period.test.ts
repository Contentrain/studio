import { describe, expect, it } from 'vitest'
import { addMonthsClamped, usagePeriodFrom } from '../../server/utils/usage-period'

/**
 * The quota window used to be the calendar month while the invoice ran
 * from the subscription anniversary, so a workspace that subscribed on
 * the 21st got a second full quota on the 1st — one free quota per
 * customer, sized by how late in the month they signed up.
 */
describe('usage period', () => {
  const at = (iso: string) => new Date(iso)

  describe('month arithmetic', () => {
    it('clamps to the last day of a shorter month', () => {
      // setUTCMonth would overflow 31 March back one month into 3 March.
      expect(addMonthsClamped(at('2026-03-31T00:00:00Z'), -1).toISOString()).toBe('2026-02-28T00:00:00.000Z')
      expect(addMonthsClamped(at('2026-01-31T00:00:00Z'), 1).toISOString()).toBe('2026-02-28T00:00:00.000Z')
      expect(addMonthsClamped(at('2024-01-31T00:00:00Z'), 1).toISOString()).toBe('2024-02-29T00:00:00.000Z') // leap year
      expect(addMonthsClamped(at('2026-05-31T00:00:00Z'), 1).toISOString()).toBe('2026-06-30T00:00:00.000Z')
    })

    it('keeps the day when the target month is long enough', () => {
      expect(addMonthsClamped(at('2026-09-21T12:34:56Z'), 1).toISOString()).toBe('2026-10-21T12:34:56.000Z')
      expect(addMonthsClamped(at('2026-01-15T00:00:00Z'), -1).toISOString()).toBe('2025-12-15T00:00:00.000Z')
    })
  })

  describe('with a subscription', () => {
    const account = {
      subscription_status: 'active',
      current_period_start: '2026-09-21T09:00:00Z',
      current_period_end: '2026-10-21T09:00:00Z',
    }

    it('keys on the period start, not the calendar month', () => {
      const period = usagePeriodFrom(account, at('2026-09-25T00:00:00Z'))
      expect(period).toMatchObject({ key: '2026-09-21', source: 'billing' })
      expect(period.resetsAt).toBe('2026-10-21T09:00:00.000Z')
    })

    it('does NOT reset on the 1st of the next calendar month', () => {
      // The whole point: same key on 25 September and on 3 October.
      const before = usagePeriodFrom(account, at('2026-09-25T00:00:00Z'))
      const afterTheFirst = usagePeriodFrom(account, at('2026-10-03T00:00:00Z'))
      expect(afterTheFirst.key).toBe(before.key)
    })

    it('resets on the billing anniversary', () => {
      const next = usagePeriodFrom(account, at('2026-10-21T10:00:00Z'))
      expect(next.key).toBe('2026-10-21')
      expect(next.key).not.toBe('2026-09-21')
    })

    it('derives the start when the provider only sent the end', () => {
      const endOnly = { subscription_status: 'active', current_period_end: '2026-03-31T00:00:00Z' }
      // 31 March minus one month clamps to 28 February, not 3 March.
      expect(usagePeriodFrom(endOnly, at('2026-03-05T00:00:00Z')).key).toBe('2026-02-28')
    })

    it('rolls forward when the renewal webhook never arrived', () => {
      // Holding the stale key would mean the quota never resets at all.
      const stale = usagePeriodFrom(account, at('2026-12-27T00:00:00Z'))
      expect(stale.key).toBe('2026-12-21')
      expect(new Date(stale.resetsAt).getTime()).toBeGreaterThan(at('2026-12-27T00:00:00Z').getTime())
    })

    it('slices a yearly subscription into monthly windows', () => {
      // One twelve-month key would mean the counter never resets for a
      // year — the customer would get a twelfth of the quota they paid for.
      const yearly = {
        subscription_status: 'active',
        current_period_start: '2026-07-27T00:00:00Z',
        current_period_end: '2027-07-27T00:00:00Z',
      }
      const period = usagePeriodFrom(yearly, at('2026-09-21T00:00:00Z'))
      expect(period.key).toBe('2026-08-27')
      expect(period.resetsAt).toBe('2026-09-27T00:00:00.000Z')

      // And it keeps advancing with the anniversary, inside the same period.
      expect(usagePeriodFrom(yearly, at('2026-09-28T00:00:00Z')).key).toBe('2026-09-27')
    })

    it('cuts the last slice short at the billing end', () => {
      const endsMidMonth = {
        subscription_status: 'active',
        current_period_start: '2026-07-27T00:00:00Z',
        current_period_end: '2026-10-10T00:00:00Z',
      }
      const period = usagePeriodFrom(endsMidMonth, at('2026-10-01T00:00:00Z'))
      expect(period.key).toBe('2026-09-27')
      // Not 27 October — the subscription period ends first.
      expect(period.resetsAt).toBe('2026-10-10T00:00:00.000Z')
    })

    it('keeps slicing monthly past an ended period', () => {
      // Renewal not yet observed: the slices must not stall on the old end.
      const expired = {
        subscription_status: 'active',
        current_period_start: '2026-07-27T00:00:00Z',
        current_period_end: '2026-08-27T00:00:00Z',
      }
      const period = usagePeriodFrom(expired, at('2026-09-21T00:00:00Z'))
      expect(period.key).toBe('2026-08-27')
      expect(period.resetsAt).toBe('2026-09-27T00:00:00.000Z')
    })

    it('counts a trialing and a past_due subscription in its period', () => {
      expect(usagePeriodFrom({ ...account, subscription_status: 'trialing' }, at('2026-09-25T00:00:00Z')).source).toBe('billing')
      expect(usagePeriodFrom({ ...account, subscription_status: 'past_due' }, at('2026-09-25T00:00:00Z')).source).toBe('billing')
    })
  })

  describe('without a usable subscription', () => {
    it('falls back to the calendar month', () => {
      const expected = { key: '2026-09', source: 'calendar', resetsAt: '2026-10-01T00:00:00.000Z' }
      expect(usagePeriodFrom(null, at('2026-09-21T00:00:00Z'))).toMatchObject(expected)
      expect(usagePeriodFrom({}, at('2026-09-21T00:00:00Z'))).toMatchObject(expected)
      // A status that carries no billing cycle.
      expect(usagePeriodFrom({ subscription_status: 'incomplete', current_period_start: '2026-09-21T00:00:00Z' }, at('2026-09-21T00:00:00Z')))
        .toMatchObject(expected)
      // Garbage timestamps must not produce an `Invalid Date` key.
      expect(usagePeriodFrom({ subscription_status: 'active', current_period_start: 'not-a-date' }, at('2026-09-21T00:00:00Z')))
        .toMatchObject(expected)
    })

    it('falls back when the period has not opened yet', () => {
      const future = { subscription_status: 'active', current_period_start: '2027-01-01T00:00:00Z', current_period_end: '2027-02-01T00:00:00Z' }
      expect(usagePeriodFrom(future, at('2026-09-21T00:00:00Z')).source).toBe('calendar')
    })
  })

  it('never produces a key that collides with a calendar key', () => {
    const billing = usagePeriodFrom(
      { subscription_status: 'active', current_period_start: '2026-09-01T00:00:00Z', current_period_end: '2026-10-01T00:00:00Z' },
      at('2026-09-15T00:00:00Z'),
    )
    // Even when the period starts on the 1st, the key stays ten characters.
    expect(billing.key).toBe('2026-09-01')
    expect(billing.key).not.toBe('2026-09')
  })
})
