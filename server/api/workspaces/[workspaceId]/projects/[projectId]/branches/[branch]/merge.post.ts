/**
 * Merge a content branch into the content branch every reader uses.
 * Requires reviewer, admin, or owner role.
 *
 * On a `review` project the role is not the whole answer. The project's
 * approval policy decides whether this branch may land, weighed against the
 * decisions actually recorded for it — without that, a policy asking for a
 * review on the diff was satisfied by the same person pressing Merge, and
 * nothing recorded that a review had happened.
 */
import { clearBranchRequestSafe } from '~~/server/utils/branch-requests'
import { branchTip, effectiveWorkflow, loadBranchReview, resolveBranchApproval } from '~~/server/utils/branch-approval'
import { actorFromEmail, buildReceipt } from '~~/server/utils/execution-plan'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  // cr/* branch names contain slashes, so the client sends them
  // percent-encoded; without { decode: true } the raw "cr%2F..." fails the
  // startsWith('cr/') guard and would be passed verbatim to the Git API.
  const branch = getRouterParam(event, 'branch', { decode: true })

  if (!workspaceId || !projectId || !branch)
    throw createError({ statusCode: 400, message: errorMessage('validation.branch_params_required') })

  // Only cr/* branches can be merged through this endpoint
  if (!branch.startsWith('cr/'))
    throw createError({ statusCode: 400, message: errorMessage('branches.contentrain_only') })

  // Role check: only reviewer+ can merge
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('merge_branch'))
    throw createError({ statusCode: 403, message: errorMessage('branches.merge_forbidden') })

  const { git, contentRoot, workspace } = await resolveProjectContext(workspaceId, projectId)
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const workflow = effectiveWorkflow(brain.config?.workflow, hasFeature(plan, 'workflow.review'))

  const db = useDatabaseProvider()
  const engine = createContentEngine({ git, contentRoot, projectId })
  const startedAt = new Date().toISOString()

  // An auto-merge project asks nobody's permission — building the review and
  // reading the grants to answer a question it never poses would only make the
  // merge slower.
  let approval: Awaited<ReturnType<typeof resolveBranchApproval>> | null = null
  if (workflow === 'review') {
    const review = await loadBranchReview({ git, contentRoot, projectId, branch, canMerge: true, canReject: true })
    approval = await resolveBranchApproval({
      projectId,
      review,
      workflow,
      policy: brain.approvalPolicy,
      commitSha: await branchTip(git, branch),
    })
    if (!approval.decision.allowed) {
      throw createError({
        statusCode: 403,
        message: errorMessage('branches.approval_required'),
        data: { approval: approval.decision },
      })
    }
  }

  const mergeResult = await engine.mergeBranch(branch)
  if (mergeResult.merged) clearBranchRequestSafe(projectId, branch)

  // The receipt outlives the grants: they are cleared with the branch, and an
  // audit record whose evidence can be deleted out from under it is not one.
  if (approval && mergeResult.merged) {
    const receipt = buildReceipt({
      plan: approval.plan,
      grants: approval.grants,
      actor: actorFromEmail(session.user.email, permissions.workspaceRole),
      status: 'completed',
      startedAt,
      finishedAt: new Date().toISOString(),
    })
    await db.recordReceipt({
      projectId,
      workspaceId,
      target: branch,
      planHash: approval.plan.plan_hash,
      receipt: receipt as unknown as Record<string, unknown>,
    }).catch(() => { /* the merge happened; losing the record must not undo it */ })
    await db.clearApprovals(projectId, branch).catch(() => {})
  }

  // Emit webhook event (fire-and-forget)
  emitWebhookEvent(projectId, workspaceId, 'branch.merged', {
    branch,
    source: 'api',
  }).catch(() => {})

  return mergeResult
})
