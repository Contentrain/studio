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
 * Seconds a write must wait, or null when it may run.
 */
export function mcpWriteRetryAfterSeconds(installationId: number, now: number = Date.now()): number | null {
  const budget = getGitHubRateBudget(installationId, now)
  if (!budget) return null
  if (budget.remaining >= uiReserveFor(budget.limit)) return null
  return Math.max(1, Math.ceil((budget.resetAt - now) / 1000))
}
