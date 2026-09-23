import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin)

describe('trial reminder windows', () => {
  it('warns a week ahead, then 3 days, 1 day and on the day — in stage order', async () => {
    const { WINDOWS } = await import('../../server/plugins/trial-reminder')
    const DAY = 24 * 60 * 60 * 1000

    expect(WINDOWS.map(w => [w.stage, w.trialEndsText])).toEqual([
      [1, 'in 7 days'],
      [2, 'in 3 days'],
      [3, 'tomorrow'],
      [4, 'today'],
    ])
    // Each window sits entirely before the previous one (no overlap), so a
    // trial is in at most one window per run.
    for (let i = 1; i < WINDOWS.length; i++)
      expect(WINDOWS[i]!.toOffsetMs).toBeLessThan(WINDOWS[i - 1]!.fromOffsetMs)
    expect(WINDOWS[0]!.fromOffsetMs).toBe(6.5 * DAY)
  })
})
