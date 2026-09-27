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
import { effectiveWorkflow, recordMergeReceipt, resolveMergeApproval } from '~~/server/utils/branch-approval'
import { actorFromEmail } from '~~/server/utils/execution-plan'

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

  const engine = createContentEngine({ git, contentRoot, projectId })
  const startedAt = new Date().toISOString()

  const approval = await resolveMergeApproval({ git, contentRoot, projectId, branch, workflow, policy: brain.approvalPolicy })
  if (approval && !approval.decision.allowed) {
    throw createError({
      statusCode: 403,
      message: errorMessage('branches.approval_required'),
      data: { approval: approval.decision },
    })
  }

  const mergeResult = await engine.mergeBranch(branch)
  if (mergeResult.merged) clearBranchRequestSafe(projectId, branch)

  if (approval && mergeResult.merged) {
    await recordMergeReceipt({
      projectId,
      workspaceId,
      branch,
      approval,
      actor: actorFromEmail(session.user.email, permissions.workspaceRole),
      startedAt,
    })
  }

  // Emit webhook event (fire-and-forget)
  emitWebhookEvent(projectId, workspaceId, 'branch.merged', {
    branch,
    source: 'api',
  }).catch(() => {})

  return mergeResult
})
