import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetUsagePeriodCache, resolveUsagePeriodCached } from '../../server/utils/usage-period'

const getActivePaymentAccount = vi.fn()

const ACCOUNT = { subscription_status: 'active', current_period_start: '2026-09-21T00:00:00Z', current_period_end: '2026-10-21T00:00:00Z' }
const at = (iso: string) => new Date(iso)

describe('resolveUsagePeriodCached', () => {
  beforeEach(() => {
    __resetUsagePeriodCache()
    getActivePaymentAccount.mockReset().mockResolvedValue(ACCOUNT)
    vi.stubGlobal('useDatabaseProvider', () => ({ getActivePaymentAccount }))
  })

  it('reads the account once a minute, not once a request', async () => {
    await resolveUsagePeriodCached('ws', at('2026-09-25T10:00:00Z'))
    await resolveUsagePeriodCached('ws', at('2026-09-25T10:00:30Z'))
    expect(getActivePaymentAccount).toHaveBeenCalledTimes(1)
    await resolveUsagePeriodCached('ws', at('2026-09-25T10:01:30Z'))
    expect(getActivePaymentAccount).toHaveBeenCalledTimes(2)
  })

  it('works the window out at each call\'s own time, so a slice boundary is never held past', async () => {
    const before = await resolveUsagePeriodCached('ws', at('2026-10-20T23:59:30Z'))
    const after = await resolveUsagePeriodCached('ws', at('2026-10-21T00:00:10Z'))
    expect(before.key).toBe('2026-09-21')
    // The cached account is the old period; the roll-forward in usagePeriodFrom opens the next slice.
    expect(after.key).toBe('2026-10-21')
    expect(getActivePaymentAccount).toHaveBeenCalledTimes(1)
  })

  it('degrades to the calendar month on a failed read, and does not remember the failure', async () => {
    getActivePaymentAccount.mockRejectedValueOnce(new Error('down'))
    expect((await resolveUsagePeriodCached('ws', at('2026-09-25T10:00:00Z'))).source).toBe('calendar')
    expect((await resolveUsagePeriodCached('ws', at('2026-09-25T10:00:01Z'))).source).toBe('billing')
  })
})
