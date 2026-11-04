import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const endPrepaidYear = vi.fn()
vi.mock('../../server/utils/migrate-revoke', () => ({
  endPrepaidYear: (...args: unknown[]) => endPrepaidYear(...args),
}))

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2027-10-05T12:00:00Z')

function year(endsInDays: number, extra: Record<string, unknown> = {}) {
  return {
    grant_id: 'grant-1',
    plan: 'pro',
    prepaid_ends_at: new Date(NOW.getTime() + endsInDays * DAY).toISOString(),
    renewal_subscription_id: null,
    workspace_id: 'ws-1',
    workspace_name: 'Acme',
    workspace_slug: 'acme',
    owner_id: 'user-1',
    ...extra,
  }
}

describe('prepaid year-end sweep', () => {
  let due: Record<number, Record<string, unknown>[]>
  let db: { listPrepaidYearsDue: ReturnType<typeof vi.fn>, setPrepaidReminderStage: ReturnType<typeof vi.fn> }
  let sendEmail: ReturnType<typeof vi.fn>

  beforeEach(() => {
    endPrepaidYear.mockReset().mockResolvedValue(undefined)
    due = {}
    db = {
      listPrepaidYearsDue: vi.fn(async ({ requiredStage }: { requiredStage: number }) => due[requiredStage] ?? []),
      setPrepaidReminderStage: vi.fn().mockResolvedValue(undefined),
    }
    sendEmail = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.example.com' }, emailReplyTo: '', emailLinks: {} }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function sweep() {
    const { runPrepaidSweep } = await import('../../server/utils/migrate-prepaid-sweep')
    return runPrepaidSweep({ db: db as never, email: { sendEmail }, ownerEmail: async () => 'owner@example.com', siteUrl: 'https://studio.example.com', now: NOW })
  }

  it('asks windows that cover T-30 to T-7, the last week, and every year already ended', async () => {
    await sweep()
    const calls = db.listPrepaidYearsDue.mock.calls.map(([q]) => q as { from: string, to: string, requiredStage: number })
    expect(calls.map(c => c.requiredStage)).toEqual([1, 2, 3])
    expect(Date.parse(calls[0]!.to) - NOW.getTime()).toBe(30 * DAY)
    expect(Date.parse(calls[0]!.from)).toBe(Date.parse(calls[1]!.to))
    expect(Date.parse(calls[2]!.to)).toBe(NOW.getTime())
  })

  it('T-30: mails the owner the date and the yearly prices, then moves the cursor', async () => {
    due[1] = [year(30)]
    await expect(sweep()).resolves.toEqual({ reminded: 1, ended: 0, renewed: 0 })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const sent = sendEmail.mock.calls[0]![0] as { to: string, html: string, text: string }
    expect(sent.to).toBe('owner@example.com')
    expect(sent.text).toContain('November 4, 2027')
    expect(sent.text).toContain('https://studio.example.com/w/acme/settings?tab=billing')
    expect(sent.text).toMatch(/\$490/)
    expect(db.setPrepaidReminderStage).toHaveBeenCalledWith('grant-1', 1)
    expect(endPrepaidYear).not.toHaveBeenCalled()
  })

  it('a year Studio continues after gets no "choose a plan" mail, only the cursor', async () => {
    due[2] = [year(5, { renewal_subscription_id: 'sub_renewal' })]
    await expect(sweep()).resolves.toEqual({ reminded: 0, ended: 0, renewed: 0 })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(db.setPrepaidReminderStage).toHaveBeenCalledWith('grant-1', 2)
  })

  it('the end without a renewal: the year comes off, then the owner is told', async () => {
    const row = year(-0.1)
    due[3] = [row]
    await expect(sweep()).resolves.toEqual({ reminded: 0, ended: 1, renewed: 0 })
    expect(endPrepaidYear).toHaveBeenCalledWith('ws-1', row.prepaid_ends_at)
    expect(db.setPrepaidReminderStage).toHaveBeenCalledWith('grant-1', 3)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('the end with a renewal: the year comes off and nothing is mailed', async () => {
    due[3] = [year(-0.1, { renewal_subscription_id: 'sub_renewal' })]
    await expect(sweep()).resolves.toEqual({ reminded: 0, ended: 0, renewed: 1 })
    expect(endPrepaidYear).toHaveBeenCalledTimes(1)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('a failure leaves the cursor where it was, so the next run retries; a failed ended mail does not', async () => {
    due[1] = [year(20)]
    due[3] = [year(-1, { grant_id: 'grant-2' })]
    sendEmail.mockRejectedValueOnce(new Error('mail down'))
    endPrepaidYear.mockRejectedValueOnce(new Error('db down'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(sweep()).resolves.toEqual({ reminded: 0, ended: 0, renewed: 0 })
    expect(db.setPrepaidReminderStage).not.toHaveBeenCalled()

    // The year came off; only the mail after it failed.
    sendEmail.mockRejectedValueOnce(new Error('mail down'))
    due[1] = []
    await expect(sweep()).resolves.toEqual({ reminded: 0, ended: 1, renewed: 0 })
    expect(db.setPrepaidReminderStage).toHaveBeenCalledWith('grant-2', 3)
    errors.mockRestore()
  })
})
