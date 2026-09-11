/**
 * Withdraw your own decision on the next release. Only your own — see
 * `branches/[branch]/approve.delete.ts`.
 */
import { effectiveWorkflow } from '~~/server/utils/branch-approval'
import { actorFromEmail } from '~~/server/utils/execution-plan'
import { RELEASE_TARGET, resolveReleaseDecision } from '~~/server/utils/release-approval'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const email = session.user.email
  if (!email)
    throw createError({ statusCode: 400, message: errorMessage('branches.approval_needs_identity') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const { git, contentRoot, workspace } = await resolveProjectContext(workspaceId, projectId)
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const workflow = effectiveWorkflow(brain.config?.workflow, hasFeature(plan, 'workflow.review'))

  await db.deleteApproval(projectId, RELEASE_TARGET, email)
  return { approval: await resolveReleaseDecision({ projectId, workflow, policy: brain.approvalPolicy, createdBy: actorFromEmail(email) }) }
})
