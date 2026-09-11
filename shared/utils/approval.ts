/**
 * The approval state of a plan, as both sides read it.
 *
 * Shared rather than server-owned because the panel and the routes have to
 * agree about what "blocked" means down to the reason: the panel's job is to
 * answer "why is this still waiting" before someone presses Merge and finds
 * out from a 403.
 */

import type { ExecutionScope, RiskClass } from '@contentrain/types'

export interface PlanRequirement {
  gate: string
  mode: string
  minApprovals: number
  /** Still needed; 0 when satisfied. */
  remaining: number
  because: RiskClass
  roles?: string[]
  /** Who has signed toward this requirement, in grant order. */
  approvers: string[]
}

export interface PlanDecision {
  allowed: boolean
  risk: RiskClass
  planHash: string
  intent: string
  scope: ExecutionScope
  /** One line per blocker, written for the person reading. Empty when allowed. */
  reasons: string[]
  requirements: PlanRequirement[]
  /**
   * Decisions that were given but do not count, each with a machine-readable
   * cause. The question is never "is it blocked" — it is "I approved this, why
   * is it still blocked".
   */
  rejectedGrants: Array<{ approver: string, reason: string }>
}

export interface ApprovalSignature {
  approver: string
  at: string
  note: string | null
}

/** The first 12 hex characters — enough to name a plan in a UI, in a log, or out loud. */
export function shortPlanHash(hash: string): string {
  return hash.slice(0, 12)
}
