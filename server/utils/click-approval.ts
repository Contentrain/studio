/**
 * A change an owner's click asked for, merged under that click (#482, #488): on a review project the click is the
 * clicker's approval, recorded against the branch's plan and tip (approver, role, why) like any reviewer's grant, the
 * approval is asked again, the branch is merged under the approved tip and a receipt says who let it in. A policy that
 * wants more than that one grant (more approvals, another role) leaves the branch for its reviewers. With no approver
 * (nobody clicked: the worker, a sweep), review leaves it held: nothing unattended approves.
 */
import type { DatabaseProvider } from '../providers/database'
import type { GitProvider } from '../providers/git'
import { gateForPlan } from './approval-gate'
import { effectiveWorkflow, recordMergeReceipt, resolveMergeApproval } from './branch-approval'
import type { BrainCacheEntry } from './brain-cache'
import type { EngineMergeResult } from './content-engine/types'
import { actorFromEmail } from './execution-plan'
import { hasFeature } from './license'

/** The owner or admin whose click asked for the change. */
export interface ClickApprover {
  id: string
  email: string
  role: string | null
  workspaceId: string
}

export interface MergeOnClickInput {
  db: Pick<DatabaseProvider, 'recordApproval'>
  git: GitProvider
  contentRoot: string
  projectId: string
  plan: string
  branch: string
  /** The project's brain (`getOrBuildBrainCache`): its workflow and approval policy. */
  brain: Pick<BrainCacheEntry, 'config' | 'approvalPolicy'>
  engine: { mergeBranch: (branch: string, options?: { expectedHead?: string }) => Promise<EngineMergeResult> }
  approver?: ClickApprover
  /** Why, on the approval: what the click asked for. */
  note: string
}

/** `held`: the branch waits for a reviewer; otherwise the merge result (a conflict throws from the engine as it does). */
export async function mergeOnClick(input: MergeOnClickInput): Promise<{ held: true } | { held: false, merge: EngineMergeResult }> {
  const { git, contentRoot, projectId, branch } = input
  const workflow = effectiveWorkflow(input.brain.config?.workflow, hasFeature(input.plan, 'workflow.review'))
  const startedAt = new Date().toISOString()
  let approval: Awaited<ReturnType<typeof resolveMergeApproval>> = null
  if (workflow === 'review') {
    if (!input.approver) return { held: true }
    const ask = () => resolveMergeApproval({ git, contentRoot, projectId, branch, workflow, policy: input.brain.approvalPolicy ?? null })
    const before = await ask()
    if (!before) return { held: true }
    await input.db.recordApproval({
      projectId,
      workspaceId: input.approver.workspaceId,
      target: branch,
      gate: gateForPlan(before.decision),
      planHash: before.plan.plan_hash,
      commitSha: before.commitSha ?? null,
      approverId: input.approver.id,
      approverEmail: input.approver.email,
      approverRole: input.approver.role,
      note: input.note,
    })
    approval = await ask()
    // A policy that asks for more than this one grant (more approvals, another role) keeps it for its reviewers.
    if (!approval?.decision.allowed) return { held: true }
  }
  const merge = await input.engine.mergeBranch(branch, approval?.commitSha ? { expectedHead: approval.commitSha } : {})
  // The receipt says who let it in; it also clears the grant (`recordMergeReceipt`).
  if (approval && input.approver && merge.merged)
    await recordMergeReceipt({ projectId, workspaceId: input.approver.workspaceId, branch, approval, actor: actorFromEmail(input.approver.email), startedAt })
  return { held: false, merge }
}
