/**
 * Withdraw your own decision on a pending branch.
 *
 * Only your own: a standing approval is a person's opinion, and removing
 * someone else's is not review, it is overruling them silently.
 */
import { requireBranchApprovalContext } from '~~/server/utils/branch-approval'

export default defineEventHandler(async (event) => {
  const ctx = await requireBranchApprovalContext(event)
  await useDatabaseProvider().deleteApproval(ctx.projectId, ctx.branch, ctx.email)
  return { approval: (await ctx.resolve()).decision }
})
