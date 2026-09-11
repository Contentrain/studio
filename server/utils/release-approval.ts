/**
 * The release gate — S-10's separate question.
 *
 * Content approval is not production permission. A branch's grants are given
 * for that branch's plan hash; a release has its own plan at `deployment` risk,
 * its own target, and therefore its own grants. Neither can satisfy the other,
 * which is the whole point of keeping them apart.
 *
 * The release plan is derived rather than stored, exactly like a branch's:
 * `buildReleasePlan` is deterministic in the project and target, so a grant
 * given for it stays valid until someone changes what a release means.
 */

import type { ActorRef, ApprovalPolicyFile } from '@contentrain/types'
import type { PlanDecision } from '../../shared/utils/approval'
import { evaluatePlan } from './approval-gate'
import { buildReleasePlan, grantFromRow } from './execution-plan'

/** One release queue per project — a deploy puts the whole site live, not part of it. */
export const RELEASE_TARGET = 'release'

export async function resolveReleaseDecision(input: {
  projectId: string
  workflow: string
  policy: ApprovalPolicyFile | null
  createdBy: ActorRef
  reason?: string
  now?: string
}): Promise<PlanDecision> {
  const plan = await buildReleasePlan({
    projectId: input.projectId,
    target: RELEASE_TARGET,
    reason: input.reason ?? 'manual',
    createdBy: input.createdBy,
  })

  if (input.workflow !== 'review')
    return evaluatePlan({ workflow: input.workflow, plan, grants: [] })

  const rows = await useDatabaseProvider().listApprovals(input.projectId, RELEASE_TARGET)
  return evaluatePlan({
    workflow: input.workflow,
    plan,
    policy: input.policy,
    grants: rows.map(r => grantFromRow(r as Record<string, unknown>)),
    ...(input.now ? { now: input.now } : {}),
  })
}
