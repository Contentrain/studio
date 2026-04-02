import { describe, expect, it, vi } from 'vitest'
import { checkRateLimit } from '../../server/utils/rate-limit'

describe('rate limit utility (in-memory fallback)', () => {
  it('allows requests within the sliding window', async () => {
    const key = `within-window-${Date.now()}`

    expect((await checkRateLimit(key, 2, 1000)).allowed).toBe(true)
    expect((await checkRateLimit(key, 2, 1000)).allowed).toBe(true)
  })

  it('blocks requests after the limit and recovers after the window expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T00:00:00Z'))

    const key = `reset-window-${Date.now()}`

    expect((await checkRateLimit(key, 1, 1000)).allowed).toBe(true)

    const blocked = await checkRateLimit(key, 1, 1000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)

    vi.advanceTimersByTime(1001)

    expect((await checkRateLimit(key, 1, 1000)).allowed).toBe(true)

    vi.useRealTimers()
  })

  it('tracks remaining count correctly', async () => {
    const key = `remaining-${Date.now()}`

    const first = await checkRateLimit(key, 3, 5000)
    expect(first.allowed).toBe(true)
    expect(first.remaining).toBe(2)

    const second = await checkRateLimit(key, 3, 5000)
    expect(second.allowed).toBe(true)
    expect(second.remaining).toBe(1)

    const third = await checkRateLimit(key, 3, 5000)
    expect(third.allowed).toBe(true)
    expect(third.remaining).toBe(0)

    const fourth = await checkRateLimit(key, 3, 5000)
    expect(fourth.allowed).toBe(false)
    expect(fourth.remaining).toBe(0)
  })

  it('isolates different keys', async () => {
    const keyA = `iso-a-${Date.now()}`
    const keyB = `iso-b-${Date.now()}`

    await checkRateLimit(keyA, 1, 5000)
    const blockedA = await checkRateLimit(keyA, 1, 5000)
    expect(blockedA.allowed).toBe(false)

    const allowedB = await checkRateLimit(keyB, 1, 5000)
    expect(allowedB.allowed).toBe(true)
  })

  it('returns retryAfterMs of zero when allowed', async () => {
    const key = `retry-zero-${Date.now()}`
    const result = await checkRateLimit(key, 5, 5000)
    expect(result.retryAfterMs).toBe(0)
  })

  it('uses default parameters (10 requests, 60s window)', async () => {
    const key = `defaults-${Date.now()}`

    for (let i = 0; i < 10; i++) {
      const r = await checkRateLimit(key)
      expect(r.allowed).toBe(true)
    }

    const blocked = await checkRateLimit(key)
    expect(blocked.allowed).toBe(false)
  })

  it('supports custom window durations', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T00:00:00Z'))

    const key = `custom-window-${Date.now()}`

    // 2 requests per 500ms
    await checkRateLimit(key, 2, 500)
    await checkRateLimit(key, 2, 500)
    expect((await checkRateLimit(key, 2, 500)).allowed).toBe(false)

    // Advance 501ms — window resets
    vi.advanceTimersByTime(501)
    expect((await checkRateLimit(key, 2, 500)).allowed).toBe(true)

    vi.useRealTimers()
  })

  it('falls back to in-memory when REDIS_URL is not set', async () => {
    // REDIS_URL is not set in test env — should use in-memory and work fine
    const key = `fallback-${Date.now()}`
    const result = await checkRateLimit(key, 5, 1000)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(4)
  })
})
