import { describe, expect, it, vi } from 'vitest'
import { planUsageAlerts, runUsageAlerts } from '../../server/utils/usage-alerts'
import type { UsageAlertKey } from '../../server/providers/database'

/**
 * Before this job the only 80 % / 100 % warning lived in Settings › Billing,
 * for an owner who happened to open it. AI credits ran out with no word, and a
 * public form limit turned visitors away while the owner learned it from a
 * lost lead. The owner is now emailed once per meter, period and threshold.
 */
const NOW = new Date('2026-09-23T12:00:00Z')

function fakeDb(usage: Partial<Record<'ai' | 'api' | 'forms' | 'comments' | 'cdn' | 'mcp', number>>, workspace: Record<string, unknown> = {}) {
  const claimed = new Set<string>()
  const id = (k: UsageAlertKey) => `${k.workspaceId}|${k.meter}|${k.periodKey}|${k.threshold}`
  return {
    claimed,
    listWorkspacesForUsageAlerts: vi.fn().mockResolvedValue([{
      id: 'ws-1', name: 'Lanista', slug: 'lanista', type: 'team', plan: 'pro', owner_id: 'owner-1',
      overage_settings: {}, media_storage_bytes: 0, ...workspace,
    }]),
    getActivePaymentAccount: vi.fn().mockResolvedValue({
      // A pre-v2 subscription: $0.03 credits, Pro 350 AI (credit-unit.ts).
      credit_unit: '0.03',
      subscription_id: 'sub_1', subscription_status: 'active',
      current_period_start: '2026-09-15T00:00:00Z', current_period_end: '2026-10-15T00:00:00Z',
      trial_ends_at: null, grace_period_ends_at: null,
    }),
    getWorkspaceMonthlyAIUsage: vi.fn(async (_ws: string, _k: string, source?: string) => source === 'byoa' ? 0 : usage.ai ?? 0),
    getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(usage.api ?? 0),
    countMonthlySubmissions: vi.fn().mockResolvedValue(usage.forms ?? 0),
    countMonthlyComments: vi.fn().mockResolvedValue(usage.comments ?? 0),
    getWorkspaceMonthlyCDNBandwidth: vi.fn().mockResolvedValue((usage.cdn ?? 0) * 1024 ** 3),
    getWorkspaceMonthlyMcpCloudUsage: vi.fn().mockResolvedValue(usage.mcp ?? 0),
    claimUsageAlert: vi.fn(async (k: UsageAlertKey) => {
      if (claimed.has(id(k))) return false
      claimed.add(id(k))
      return true
    }),
    releaseUsageAlert: vi.fn(async (k: UsageAlertKey) => { claimed.delete(id(k)) }),
  }
}

function deps(db: ReturnType<typeof fakeDb>, sendEmail = vi.fn().mockResolvedValue(undefined)) {
  return { db: db as never, sendEmail, ownerEmail: async () => 'owner@lanista.test', siteUrl: 'https://studio.test', now: NOW }
}

describe('usage alerts', () => {
  it('tells the owner when AI credits and public form submissions have stopped, and until when', async () => {
    // Pro: 350 AI credits (billing period from the 15th), 3000 submissions (calendar month).
    const db = fakeDb({ ai: 1036, forms: 3100 })
    const sendEmail = vi.fn().mockResolvedValue(undefined)
    const sent = await runUsageAlerts(deps(db, sendEmail))

    expect(sent.map(s => `${s.meter}:${s.threshold}:${s.template}`).sort()).toEqual([
      'ai_messages:100:usage-limit-reached',
      'form_submissions:100:usage-limit-reached',
    ])
    expect(sendEmail).toHaveBeenCalledTimes(2)
    const mails = sendEmail.mock.calls.map(([m]) => m as { to: string, subject: string, html: string })
    const forms = mails.find(m => m.subject.includes('Form Submissions'))!
    expect(forms.to).toBe('owner@lanista.test')
    expect(forms.html).toContain('being rejected until October 1')
    expect(forms.html).toContain('https://studio.test/w/lanista/settings?tab=billing')
    const ai = mails.find(m => m.subject.includes('AI Credits'))!
    expect(ai.html).toContain('paused until October 15')
  })

  it('sends each alert once per period', async () => {
    const db = fakeDb({ ai: 1036 })
    const sendEmail = vi.fn().mockResolvedValue(undefined)
    await runUsageAlerts(deps(db, sendEmail))
    await runUsageAlerts(deps(db, sendEmail))
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('warns at 80 %, and says overage is billed rather than stopped when it is on', async () => {
    const db = fakeDb({ ai: 300, forms: 3100 }, { overage_settings: { form_submissions: true } })
    const sendEmail = vi.fn().mockResolvedValue(undefined)
    const sent = await runUsageAlerts(deps(db, sendEmail))
    expect(sent.map(s => `${s.meter}:${s.threshold}:${s.template}`).sort()).toEqual([
      'ai_messages:80:usage-warning',
      'form_submissions:100:usage-overage-started',
    ])
    const overage = sendEmail.mock.calls.map(([m]) => m as { html: string }).find(m => m.html.includes('billed at'))!
    expect(overage.html).toContain('$0.01')
  })

  it('CDN delivery: 100 % says it is still serving, 120 % says it stopped — each once', async () => {
    // Pro: 60 GB. 65 GB is past the limit but under the 120 % hard stop.
    const grace = fakeDb({ cdn: 65 })
    const graceMail = vi.fn().mockResolvedValue(undefined)
    expect(await runUsageAlerts(deps(grace, graceMail))).toEqual([
      expect.objectContaining({ meter: 'cdn_bandwidth', threshold: 100, template: 'usage-limit-reached' }),
    ])
    expect(graceMail.mock.calls[0]![0].html).toContain('still being delivered')
    expect(graceMail.mock.calls[0]![0].html).toContain('120%')

    const stopped = fakeDb({ cdn: 73 })
    const stopMail = vi.fn().mockResolvedValue(undefined)
    expect(await runUsageAlerts(deps(stopped, stopMail))).toEqual([
      expect.objectContaining({ meter: 'cdn_bandwidth', threshold: 120, template: 'usage-limit-reached' }),
    ])
    expect(stopMail.mock.calls[0]![0].html).toContain('has stopped')
    // The next sweep in the same month sends nothing more.
    expect(await runUsageAlerts(deps(stopped, stopMail))).toEqual([])
  })

  it('a failed send is retried on the next run', async () => {
    const db = fakeDb({ ai: 1036 })
    const failing = vi.fn().mockRejectedValueOnce(new Error('resend down')).mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runUsageAlerts(deps(db, failing))).toEqual([])
    expect(await runUsageAlerts(deps(db, failing))).toHaveLength(1)
    expect(failing).toHaveBeenCalledTimes(2)
  })

  it('judges the plan the limits are enforced against — an expired trial alerts nothing', async () => {
    const db = fakeDb({ ai: 1036 })
    db.getActivePaymentAccount.mockResolvedValue({
      subscription_id: 'sub_1', subscription_status: 'trialing',
      current_period_start: '2026-08-01T00:00:00Z', current_period_end: '2026-08-15T00:00:00Z',
      trial_ends_at: '2026-08-15T00:00:00Z', grace_period_ends_at: null,
    })
    const sendEmail = vi.fn()
    expect(await runUsageAlerts(deps(db, sendEmail))).toEqual([])
  })

  it('waits for the limit itself: 2 990 of 3 000 is a warning, not "stopped"', async () => {
    const db = fakeDb({ forms: 2990 })
    const sendEmail = vi.fn().mockResolvedValue(undefined)
    const sent = await runUsageAlerts(deps(db, sendEmail))
    expect(sent.map(s => `${s.meter}:${s.threshold}`)).toEqual(['form_submissions:80'])
  })

  it('storage alerts once per threshold, not every month, and does not promise a reset', async () => {
    const db = fakeDb({}, { media_storage_bytes: 26 * 1024 ** 3 }) // Pro: 25 GB (catalog v2, for every account)
    const sendEmail = vi.fn().mockResolvedValue(undefined)
    const first = await runUsageAlerts(deps(db, sendEmail))
    expect(first).toEqual([expect.objectContaining({ meter: 'media_storage', threshold: 100, periodKey: 'level' })])
    const html = (sendEmail.mock.calls[0]![0] as { html: string }).html
    expect(html).toContain('until you free up space')
    expect(html).not.toMatch(/resets on/i)
    // Next month: same level, no new mail.
    const later = await runUsageAlerts({ ...deps(db, sendEmail), now: new Date('2026-10-23T12:00:00Z') })
    expect(later).toEqual([])
  })

  it('offers overage only where it can be turned on', async () => {
    const db = fakeDb({ forms: 3100, comments: 10_500 })
    const sendEmail = vi.fn().mockResolvedValue(undefined)
    await runUsageAlerts(deps(db, sendEmail))
    const mails = sendEmail.mock.calls.map(([m]) => m as { subject: string, html: string })
    expect(mails.find(m => m.subject.includes('Form Submissions'))!.html).toContain('allow overage or change the plan')
    const comments = mails.find(m => m.subject.includes('Comments'))!.html
    expect(comments).toContain('change the plan in Billing')
    expect(comments).not.toContain('allow overage')
  })

  it('does not mail a workspace that is locked behind the paywall', async () => {
    const db = fakeDb({ ai: 1036 })
    db.getActivePaymentAccount.mockResolvedValue({
      subscription_id: 'sub_1', subscription_status: 'past_due',
      current_period_start: '2026-08-15T00:00:00Z', current_period_end: '2026-09-15T00:00:00Z',
      trial_ends_at: null, grace_period_ends_at: '2026-09-20T00:00:00Z',
    })
    const sendEmail = vi.fn()
    expect(await runUsageAlerts(deps(db, sendEmail))).toEqual([])
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('the storage warning says storage does not reset, with no empty date', async () => {
    const db = fakeDb({}, { media_storage_bytes: 21 * 1024 ** 3 }) // 84 % of 25 GB
    const sendEmail = vi.fn().mockResolvedValue(undefined)
    await runUsageAlerts(deps(db, sendEmail))
    const html = (sendEmail.mock.calls[0]![0] as { html: string }).html
    expect(html).toContain('Storage does not reset each month')
    expect(html).not.toContain('resets on <strong></strong>')
  })

  it('skips a meter it cannot read instead of counting it as 0, and still alerts on the others (AI-15)', async () => {
    const db = fakeDb({ ai: 1036 })
    db.countMonthlySubmissions.mockRejectedValue(new Error('connection reset'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sendEmail = vi.fn().mockResolvedValue(undefined)
    const sent = await runUsageAlerts(deps(db, sendEmail))
    expect(sent.map(s => `${s.meter}:${s.threshold}`)).toEqual(['ai_messages:100'])
    expect(error.mock.calls.some(([line]) => String(line).includes('[billing-risk] usage-read.form_submissions'))).toBe(true)
    error.mockRestore()
  })

  it('never plans an alert for an unavailable meter, whatever its numbers say', () => {
    const base = { limitKey: 'ai.messages_per_month', name: 'AI Credits', limit: 350, overageEnabled: false, overageSellable: true, overageLock: null, overageUnits: 0, overageUnitPrice: 0, overageAmount: 0, unit: 'credits', percentage: 120, resetsAt: null, periodKey: '2026-09-15' }
    expect(planUsageAlerts([{ ...base, key: 'ai_messages', current: 420, unavailable: true }])).toEqual([])
    expect(planUsageAlerts([{ ...base, key: 'ai_messages', current: 420 }])).toHaveLength(1)
  })

  it('reads a v2 account in its own unit: 1 036 credits are 65 % of Pro\'s 1 600, no alert', async () => {
    const db = fakeDb({ ai: 1036 })
    db.getActivePaymentAccount.mockResolvedValue({
      credit_unit: '0.01',
      subscription_id: 'sub_2', subscription_status: 'active',
      current_period_start: '2026-09-15T00:00:00Z', current_period_end: '2026-10-15T00:00:00Z',
      trial_ends_at: null, grace_period_ends_at: null,
    })
    const sendEmail = vi.fn().mockResolvedValue(undefined)
    expect(await runUsageAlerts(deps(db, sendEmail))).toEqual([])
    // The same count on a pre-v2 account is past its 350.
    expect(await runUsageAlerts(deps(fakeDb({ ai: 1036 }), sendEmail))).toEqual([expect.objectContaining({ meter: 'ai_messages', threshold: 100 })])
  })
})
