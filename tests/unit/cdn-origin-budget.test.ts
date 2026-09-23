import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ getWorkspaceMonthlyCDNBandwidth: vi.fn() }))
vi.mock('../../server/utils/providers', () => ({ useDatabaseProvider: () => db }))
vi.mock('../../server/utils/redis', () => ({ getRedis: () => null }))

const GIB = 1024 ** 3
const NOW = new Date('2026-09-23T12:00:00Z')

async function load(mode: string) {
  vi.stubGlobal('useRuntimeConfig', () => ({ cdn: { originLimit: mode } }))
  const mod = await import('../../server/utils/cdn-origin-budget')
  mod.__resetCdnOriginBudget()
  return mod
}

describe('CDN origin budget', () => {
  beforeEach(() => {
    db.getWorkspaceMonthlyCDNBandwidth.mockReset().mockResolvedValue(0)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('seeds the month from the durable total and refuses in enforce mode at the limit, until the month resets', async () => {
    const { checkCdnOriginBudget } = await load('enforce')
    db.getWorkspaceMonthlyCDNBandwidth.mockResolvedValue(2 * GIB)
    const result = await checkCdnOriginBudget({ workspaceId: 'ws', limitGb: 2, now: NOW })
    expect(db.getWorkspaceMonthlyCDNBandwidth).toHaveBeenCalledWith('ws', '2026-09')
    // 2026-10-01T00:00Z is 7.5 days after NOW.
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 7.5 * 24 * 3600 })
  })

  it('counts served bytes on top of the seed', async () => {
    const { addCdnOriginBytes, checkCdnOriginBudget } = await load('enforce')
    db.getWorkspaceMonthlyCDNBandwidth.mockResolvedValue(GIB)
    expect(await checkCdnOriginBudget({ workspaceId: 'ws', limitGb: 2, now: NOW })).toEqual({ allowed: true })
    await addCdnOriginBytes('ws', GIB, NOW)
    expect(await checkCdnOriginBudget({ workspaceId: 'ws', limitGb: 2, now: NOW })).toMatchObject({ allowed: false })
    // Read once, then served from the counter.
    expect(db.getWorkspaceMonthlyCDNBandwidth).toHaveBeenCalledTimes(1)
  })

  it('observe never refuses; off neither counts nor reads', async () => {
    db.getWorkspaceMonthlyCDNBandwidth.mockResolvedValue(10 * GIB)
    const observe = await load('observe')
    expect(await observe.checkCdnOriginBudget({ workspaceId: 'ws', limitGb: 2, now: NOW })).toEqual({ allowed: true })

    db.getWorkspaceMonthlyCDNBandwidth.mockClear()
    const off = await load('off')
    expect(await off.checkCdnOriginBudget({ workspaceId: 'ws', limitGb: 2, now: NOW })).toEqual({ allowed: true })
    expect(db.getWorkspaceMonthlyCDNBandwidth).not.toHaveBeenCalled()
  })

  it('lets the request through when the durable total cannot be read, and on an unlimited plan', async () => {
    const { checkCdnOriginBudget } = await load('enforce')
    db.getWorkspaceMonthlyCDNBandwidth.mockRejectedValue(new Error('db down'))
    expect(await checkCdnOriginBudget({ workspaceId: 'ws', limitGb: 2, now: NOW })).toEqual({ allowed: true })
    expect(await checkCdnOriginBudget({ workspaceId: 'ws2', limitGb: Infinity, now: NOW })).toEqual({ allowed: true })
  })
})
