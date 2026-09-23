/**
 * MCP Cloud write guard on the GitHub installation budget.
 *
 * A workspace's GitHub App installation has one hourly request budget
 * (5,000+). Studio's UI, the chat agent and MCP Cloud all spend it. An
 * external agent looping on write tools can drain it in minutes, and then
 * the editor cannot even list content until the window resets. So once
 * the budget falls below a reserve, MCP write tools answer 429 with
 * `Retry-After` until GitHub's window resets; reads and the UI keep
 * working on the reserve.
 *
 * The budget is what GitHub last reported on any response for the
 * installation (`getGitHubRateBudget`), per Nitro instance. Unknown budget
 * (no request yet, or the window has reset since) never blocks.
 */
import { getGitHubRateBudget } from '../providers/github-app'

/** Share of the hourly limit kept for the UI and the chat agent. */
export const UI_RESERVE_RATIO = 0.2
/** Floor for the reserve, for installations with a small limit. */
export const UI_RESERVE_MIN = 500

export function uiReserveFor(limit: number): number {
  return Math.max(UI_RESERVE_MIN, Math.ceil(limit * UI_RESERVE_RATIO))
}

/**
 * Read tools reach GitHub on every call too (the MCP provider's reader does
 * not memoize), but they stop far later than writes: only the last 5% of
 * the budget (at least 150 requests) is kept from them, so the editor's own
 * reads never starve.
 */
export const READ_RESERVE_RATIO = 0.05
export const READ_RESERVE_MIN = 150

export function readReserveFor(limit: number): number {
  return Math.max(READ_RESERVE_MIN, Math.ceil(limit * READ_RESERVE_RATIO))
}

function retryAfter(installationId: number, reserveFor: (limit: number) => number, now: number): number | null {
  const budget = getGitHubRateBudget(installationId, now)
  if (!budget) return null
  if (budget.remaining >= reserveFor(budget.limit)) return null
  return Math.max(1, Math.ceil((budget.resetAt - now) / 1000))
}

/** Seconds a write must wait, or null when it may run. */
export function mcpWriteRetryAfterSeconds(installationId: number, now: number = Date.now()): number | null {
  return retryAfter(installationId, uiReserveFor, now)
}

/** Seconds a read tool must wait, or null when it may run. */
export function mcpReadRetryAfterSeconds(installationId: number, now: number = Date.now()): number | null {
  return retryAfter(installationId, readReserveFor, now)
}
