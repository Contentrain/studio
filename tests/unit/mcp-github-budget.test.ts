import { beforeEach, describe, expect, it } from 'vitest'
import { __resetInstallationOctokitCache, getGitHubRateBudget, recordGitHubRateBudget } from '../../server/providers/github-app'
import { mcpWriteRetryAfterSeconds, UI_RESERVE_MIN, uiReserveFor } from '../../server/utils/mcp-github-budget'

const NOW = 1_800_000_000_000
const headers = (remaining: number, limit = 5000, resetIn = 1200) => ({
  'x-ratelimit-remaining': String(remaining),
  'x-ratelimit-limit': String(limit),
  'x-ratelimit-reset': String(NOW / 1000 + resetIn),
})

describe('GitHub installation budget', () => {
  beforeEach(() => __resetInstallationOctokitCache())

  it('records the budget GitHub reports and forgets it once the window resets', () => {
    recordGitHubRateBudget(7, headers(4200))
    expect(getGitHubRateBudget(7, NOW)).toEqual({ remaining: 4200, limit: 5000, resetAt: NOW + 1_200_000 })
    expect(getGitHubRateBudget(7, NOW + 1_200_000)).toBeNull()
  })

  it('ignores responses without rate headers', () => {
    recordGitHubRateBudget(7, {})
    recordGitHubRateBudget(7, undefined)
    expect(getGitHubRateBudget(7, NOW)).toBeNull()
  })

  it('keeps 20% of the limit for the UI, never less than the floor', () => {
    expect(uiReserveFor(5000)).toBe(1000)
    expect(uiReserveFor(12_500)).toBe(2500)
    expect(uiReserveFor(1000)).toBe(UI_RESERVE_MIN)
  })

  it('makes writes wait until the window resets once the reserve is reached', () => {
    recordGitHubRateBudget(7, headers(999))
    expect(mcpWriteRetryAfterSeconds(7, NOW)).toBe(1200)
    recordGitHubRateBudget(7, headers(1000))
    expect(mcpWriteRetryAfterSeconds(7, NOW)).toBeNull()
    expect(mcpWriteRetryAfterSeconds(8, NOW)).toBeNull()
  })
})
