import { describe, expect, it, vi } from 'vitest'
import { computeWorkspaceUsage } from '../../server/utils/workspace-usage'
import { usagePeriodFrom } from '../../server/utils/usage-period'

/**
 * AI-15: a meter whose read fails is never shown or used as 0. By default the
 * error propagates; the billing screen asks for `readErrors: 'unavailable'`
 * and gets that meter marked unavailable while the rest still show.
 */
const NOW = new Date('2026-09-23T12:00:00Z')

function db(overrides: Record<string, unknown> = {}) {
  return {
    getWorkspaceMonthlyAIUsage: vi.fn(async (_w: string, _k: string, source?: string) => (source === 'byoa' ? 3 : 200)),
    getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(10),
    countMonthlySubmissions: vi.fn().mockResolvedValue(3500),
    getWorkspaceMonthlyCDNBandwidth: vi.fn().mockResolvedValue(0),
    getWorkspaceMonthlyMcpCloudUsage: vi.fn().mockResolvedValue(0),
    countMonthlyComments: vi.fn().mockResolvedValue(0),
    ...overrides,
  }
}

const input = {
  workspaceId: 'ws-1',
  plan: 'pro',
  // Overage on for forms: an unreadable count must not produce an amount.
  overageSettings: { form_submissions: true },
  storageBytes: 0,
  period: usagePeriodFrom(null, NOW),
  now: NOW,
}

describe('computeWorkspaceUsage with a failed read', () => {
  it('rejects by default: no number is made up', async () => {
    const reader = db({ countMonthlySubmissions: vi.fn().mockRejectedValue(new Error('connection reset')) })
    await expect(computeWorkspaceUsage(reader as never, input)).rejects.toThrow('connection reset')
  })

  it('readErrors: \'unavailable\' marks that meter, quotes nothing for it, and keeps the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reader = db({ countMonthlySubmissions: vi.fn().mockRejectedValue(new Error('connection reset')) })
    const usage = await computeWorkspaceUsage(reader as never, { ...input, readErrors: 'unavailable' })
    const forms = usage.categories.find(c => c.key === 'form_submissions')!
    expect(forms).toMatchObject({ unavailable: true, current: 0, percentage: 0, overageUnits: 0, overageAmount: 0 })
    expect(usage.projectedOverageAmount).toBe(0)
    const ai = usage.categories.find(c => c.key === 'ai_messages')!
    expect(ai.unavailable).toBeUndefined()
    expect(ai.current).toBe(200)
    expect(usage.byoaRequests).toBe(3)
    expect(error.mock.calls.some(([line]) => String(line).includes('[billing-risk] usage-read.form_submissions: connection reset'))).toBe(true)
    error.mockRestore()
  })

  it('with every read healthy, nothing is marked unavailable', async () => {
    const usage = await computeWorkspaceUsage(db() as never, { ...input, readErrors: 'unavailable' })
    expect(usage.categories.filter(c => c.unavailable)).toEqual([])
    expect(usage.categories.find(c => c.key === 'form_submissions')!.overageUnits).toBeGreaterThan(0)
  })
})

describe('computeWorkspaceUsage reset dates', () => {
  it('names what each meter resets with, so two dates on one screen read as intended', async () => {
    const period = usagePeriodFrom({ subscription_status: 'active', current_period_start: '2026-09-10T00:00:00Z', current_period_end: '2026-10-10T00:00:00Z' }, NOW)
    const usage = await computeWorkspaceUsage(db() as never, { ...input, period, storageBytes: 1 })
    const reset = Object.fromEntries(usage.categories.map(c => [c.key, [c.resetBasis, c.resetsAt]]))
    for (const key of ['ai_messages', 'api_messages', 'mcp_calls'])
      expect(reset[key]).toEqual(['billing', '2026-10-10T00:00:00.000Z'])
    for (const key of ['form_submissions', 'comments', 'cdn_bandwidth'])
      expect(reset[key]).toEqual(['calendar', '2026-10-01T00:00:00.000Z'])
    expect(reset.media_storage).toEqual([null, null])
  })
})
