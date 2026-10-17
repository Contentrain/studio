import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: 'subscription', edition: 'ee' }) }))

const GB = 1024 ** 3
const PRICED = ['ai_credits_1c', 'cdn_origin_gb', 'media_storage_gb_months']

function gateDb(workspace: Record<string, unknown> | null, account: Record<string, unknown> | null) {
  return {
    getWorkspaceById: vi.fn().mockResolvedValue(workspace),
    getActivePaymentAccount: vi.fn().mockResolvedValue(account),
    setPaymentAccountMetadataKey: vi.fn().mockResolvedValue(true),
    setPaymentAccountMetadataJson: vi.fn().mockResolvedValue(true),
  }
}

const activeAccount = (metadata: Record<string, unknown> = {}) => ({
  customer_id: 'cus_1',
  subscription_status: 'active',
  current_period_start: '2026-09-15T00:00:00Z',
  current_period_end: '2026-10-15T00:00:00Z',
  plugin_metadata: { billable_meters: PRICED, ...metadata },
})

/**
 * A daily CDN/storage meter bills a day past the plan only when overage was
 * on, and sellable, for the whole of it. Without that the grace past the
 * plan is Studio's to pay, so the meter reports only what fits under the line.
 */
describe('overageDayGate', () => {
  const dayStart = new Date('2026-09-30T00:00:00Z')
  const now = new Date('2026-10-01T00:30:00Z')

  beforeEach(() => vi.resetModules())

  it('covers a day when the toggle was on and sellable before it began', async () => {
    const { overageDayGate } = await import('../../server/utils/overage-meter-gate')
    const db = gateDb({ plan: 'pro', overage_settings: { cdn_bandwidth: true } }, activeAccount({ overage_on_since_cdn_bandwidth: '2026-09-20T08:00:00Z' }))
    await expect(overageDayGate({ workspaceId: 'ws-1', settingsKey: 'cdn_bandwidth', dayStart, now, db })).resolves.toEqual({ plan: 'pro', covered: true })
    expect(db.setPaymentAccountMetadataKey).not.toHaveBeenCalled()
    expect(db.setPaymentAccountMetadataJson).not.toHaveBeenCalled()
  })

  it('does not cover a day the toggle was turned on during', async () => {
    const { overageDayGate } = await import('../../server/utils/overage-meter-gate')
    const db = gateDb({ plan: 'pro', overage_settings: { cdn_bandwidth: true } }, activeAccount({ overage_on_since_cdn_bandwidth: '2026-09-30T10:00:00Z' }))
    await expect(overageDayGate({ workspaceId: 'ws-1', settingsKey: 'cdn_bandwidth', dayStart, now, db })).resolves.toEqual({ plan: 'pro', covered: false })
  })

  it('with overage off, covers nothing and forgets a stale "on since"', async () => {
    const { overageDayGate } = await import('../../server/utils/overage-meter-gate')
    const db = gateDb({ plan: 'starter', overage_settings: { cdn_bandwidth: false } }, activeAccount({ overage_on_since_cdn_bandwidth: '2026-09-01T00:00:00Z' }))
    await expect(overageDayGate({ workspaceId: 'ws-1', settingsKey: 'cdn_bandwidth', dayStart, now, db })).resolves.toEqual({ plan: 'starter', covered: false })
    expect(db.setPaymentAccountMetadataJson).toHaveBeenCalledWith({ workspaceId: 'ws-1', key: 'overage_on_since_cdn_bandwidth', value: null })
  })

  it('counts a toggle that is on without a recorded instant from now: no day already run is covered', async () => {
    const { overageDayGate } = await import('../../server/utils/overage-meter-gate')
    const db = gateDb({ plan: 'pro', overage_settings: { media_storage: true } }, activeAccount())
    await expect(overageDayGate({ workspaceId: 'ws-1', settingsKey: 'media_storage', dayStart, now, db })).resolves.toEqual({ plan: 'pro', covered: false })
    expect(db.setPaymentAccountMetadataKey).toHaveBeenCalledWith({ workspaceId: 'ws-1', key: 'overage_on_since_media_storage', value: now.toISOString(), when: 'absent' })
  })

  it.each([
    ['during a trial', { subscription_status: 'trialing', trial_ends_at: '2026-10-05T00:00:00Z', plugin_metadata: { billable_meters: PRICED, overage_on_since_cdn_bandwidth: '2026-09-01T00:00:00Z' } }],
    ['on a subscription without the CDN price', { ...activeAccount({ overage_on_since_cdn_bandwidth: '2026-09-01T00:00:00Z' }), plugin_metadata: { billable_meters: ['ai_credits_1c'], overage_on_since_cdn_bandwidth: '2026-09-01T00:00:00Z' } }],
    ['on a yearly plan', { ...activeAccount(), current_period_start: '2026-01-01T00:00:00Z', current_period_end: '2027-01-01T00:00:00Z', plugin_metadata: { billable_meters: [], overage_on_since_cdn_bandwidth: '2026-09-01T00:00:00Z' } }],
  ])('covers nothing when the toggle is on but locked %s', async (_, account) => {
    const { overageDayGate } = await import('../../server/utils/overage-meter-gate')
    const db = gateDb({ plan: 'pro', overage_settings: { cdn_bandwidth: true } }, account)
    await expect(overageDayGate({ workspaceId: 'ws-1', settingsKey: 'cdn_bandwidth', dayStart, now, db })).resolves.toMatchObject({ covered: false })
  })
})

describe('planLimitBytes / bytesUnderLimit', () => {
  it('reads the plan GB as bytes', async () => {
    const { planLimitBytes } = await import('../../server/utils/overage-meter-gate')
    expect(planLimitBytes('starter', 'cdn.bandwidth_gb')).toBe(3 * GB)
    expect(planLimitBytes('pro', 'media.storage_gb')).toBe(25 * GB)
  })

  it('keeps only the part of a day under the plan line', async () => {
    const { bytesUnderLimit } = await import('../../server/utils/overage-meter-gate')
    expect(bytesUnderLimit(1 * GB, 1 * GB, 3 * GB)).toBe(1 * GB)
    expect(bytesUnderLimit(2.5 * GB, 1 * GB, 3 * GB)).toBe(0.5 * GB)
    expect(bytesUnderLimit(3.2 * GB, 1 * GB, 3 * GB)).toBe(0)
    expect(bytesUnderLimit(5 * GB, 1 * GB, Infinity)).toBe(1 * GB)
  })
})

describe('syncOverageOnSince', () => {
  it('counts a CDN/storage toggle turned on from now, forgets one turned off, and leaves the rest alone', async () => {
    const { syncOverageOnSince } = await import('../../server/utils/overage-meter-gate')
    const db = gateDb(null, null)
    const now = new Date('2026-10-17T12:00:00Z')
    await syncOverageOnSince(db, 'ws-1',
      { cdn_bandwidth: false, media_storage: true, ai_messages: false },
      { cdn_bandwidth: true, media_storage: false, ai_messages: true },
      now)
    // A re-enabled toggle replaces any stale instant: the days it spent suspended are not covered.
    expect(db.setPaymentAccountMetadataKey).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws-1', key: 'overage_on_since_cdn_bandwidth', value: now.toISOString(), when: 'different' })
    expect(db.setPaymentAccountMetadataJson).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws-1', key: 'overage_on_since_media_storage', value: null })
  })

  it('writes nothing when no CDN/storage toggle changed', async () => {
    const { syncOverageOnSince } = await import('../../server/utils/overage-meter-gate')
    const db = gateDb(null, null)
    await syncOverageOnSince(db, 'ws-1', { cdn_bandwidth: true }, { cdn_bandwidth: true, ai_messages: false }, new Date())
    expect(db.setPaymentAccountMetadataKey).not.toHaveBeenCalled()
    expect(db.setPaymentAccountMetadataJson).not.toHaveBeenCalled()
  })
})
