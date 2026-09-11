/**
 * Record this reviewer's decision on a pending branch.
 *
 * A grant is given for one plan, identified by its hash and the branch tip it
 * reviewed. Push another commit and the plan's scope changes, its hash changes
 * with it, and this decision stops counting — which is the point: an approval
 * is of a diff, not of a branch name.
 */
import { gateForPlan } from '~~/server/utils/approval-gate'
import { requireBranchApprovalContext } from '~~/server/utils/branch-approval'

export default defineEventHandler(async (event) => {
  const ctx = await requireBranchApprovalContext(event)
  const body = await readBody<{ note?: string }>(event).catch(() => ({} as { note?: string }))

  const before = await ctx.resolve()
  await useDatabaseProvider().recordApproval({
    projectId: ctx.projectId,
    workspaceId: ctx.workspaceId,
    target: ctx.branch,
    gate: gateForPlan(before.decision),
    planHash: before.plan.plan_hash,
    commitSha: ctx.commitSha ?? null,
    approverId: ctx.userId,
    approverEmail: ctx.email,
    approverRole: ctx.role,
    note: body?.note ?? null,
  })

  return { approval: (await ctx.resolve()).decision }
})
