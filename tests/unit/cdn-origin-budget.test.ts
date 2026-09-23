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

  it('enforce is the default mode', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ cdn: {} }))
    const { cdnOriginLimitMode } = await import('../../server/utils/cdn-origin-budget')
    expect(cdnOriginLimitMode()).toBe('enforce')
  })

  it('keeps serving past the limit and refuses at 120 %, until the month resets', async () => {
    const { checkCdnOriginBudget } = await load('enforce')
    db.getWorkspaceMonthlyCDNBandwidth.mockResolvedValue(2.3 * GIB)
    expect(await checkCdnOriginBudget({ workspaceId: 'grace', limitGb: 2, now: NOW })).toEqual({ allowed: true })
    db.getWorkspaceMonthlyCDNBandwidth.mockResolvedValue(2.5 * GIB)
    const result = await checkCdnOriginBudget({ workspaceId: 'ws', limitGb: 2, now: NOW })
    // 2026-10-01T00:00Z is 7.5 days after NOW.
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 7.5 * 24 * 3600 })
  })

  it('counts served bytes on top of the seed', async () => {
    const { addCdnOriginBytes, checkCdnOriginBudget } = await load('enforce')
    db.getWorkspaceMonthlyCDNBandwidth.mockResolvedValue(GIB)
    expect(await checkCdnOriginBudget({ workspaceId: 'ws', limitGb: 2, now: NOW })).toEqual({ allowed: true })
    await addCdnOriginBytes('ws', 1.4 * GIB, NOW)
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
