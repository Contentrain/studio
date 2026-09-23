import { describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ listWorkspaceCDNBandwidthForDay: vi.fn() }))
const recordCDNOriginUsage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../server/utils/providers', () => ({ useDatabaseProvider: () => db }))
vi.mock('../../server/utils/usage-metering', () => ({ recordCDNOriginUsage }))

describe('daily CDN origin meter', () => {
  it('meters each finished UTC day once per workspace, never the day in progress', async () => {
    vi.stubGlobal('defineNitroPlugin', (fn: unknown) => fn)
    const { finishedDays, meterCdnOriginDays } = await import('../../server/plugins/cdn-origin-meter')
    const now = new Date('2026-10-01T00:30:00Z')
    expect(finishedDays(now, 2)).toEqual(['2026-09-29', '2026-09-30'])

    db.listWorkspaceCDNBandwidthForDay.mockImplementation(async (day: string) =>
      day === '2026-09-30' ? [{ workspaceId: 'ws-1', bytes: 3 * 1024 ** 3 }] : [])
    expect(await meterCdnOriginDays(now)).toBe(1)
    expect(recordCDNOriginUsage).toHaveBeenCalledWith({ workspaceId: 'ws-1', day: '2026-09-30', bytes: 3 * 1024 ** 3 })
  })
})
