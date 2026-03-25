import { describe, expect, it, vi } from 'vitest'
import { checkRateLimit } from '../../server/utils/rate-limit'

describe('rate limit utility', () => {
  it('allows requests within the sliding window', () => {
    const key = `within-window-${Date.now()}`

    expect(checkRateLimit(key, 2, 1000).allowed).toBe(true)
    expect(checkRateLimit(key, 2, 1000).allowed).toBe(true)
  })

  it('blocks requests after the limit and recovers after the window expires', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T00:00:00Z'))

    const key = `reset-window-${Date.now()}`

    expect(checkRateLimit(key, 1, 1000).allowed).toBe(true)

    const blocked = checkRateLimit(key, 1, 1000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)

    vi.advanceTimersByTime(1001)

    expect(checkRateLimit(key, 1, 1000).allowed).toBe(true)
  })
})
