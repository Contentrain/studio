import { describe, expect, it, vi } from 'vitest'
import { runUsageAlerts } from '../../server/utils/usage-alerts'
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

  it('does not email about CDN bandwidth, whose limit is not enforced', async () => {
    const db = fakeDb({ cdn: 80 })
    const sendEmail = vi.fn()
    expect(await runUsageAlerts(deps(db, sendEmail))).toEqual([])
    expect(sendEmail).not.toHaveBeenCalled()
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
})
