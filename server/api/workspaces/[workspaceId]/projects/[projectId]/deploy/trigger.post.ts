/**
 * Fire the project's deploy hook now (bypasses the debounce). Workspace owner/admin.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/deploy/trigger
 */

import { triggerProjectDeploy } from '~~/server/utils/deploy-hooks'
import { effectiveWorkflow } from '~~/server/utils/branch-approval'
import { actorFromEmail, buildReceipt, buildReleasePlan, grantFromRow } from '~~/server/utils/execution-plan'
import { RELEASE_TARGET, resolveReleaseDecision } from '~~/server/utils/release-approval'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const rate = await checkRateLimit(`deploy-trigger:${projectId}`, 6, 60_000)
  if (!rate.allowed)
    throw createError({ statusCode: 429, message: errorMessage('forms.rate_limited') })

  // The release gate. Approving the content that went in is not permission to
  // put it in front of the public — a release is its own plan, at `deployment`
  // risk, with its own grants. A project not on the review workflow deploys as
  // it always did.
  const { git, contentRoot, workspace } = await resolveProjectContext(workspaceId, projectId)
  const workspacePlan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const workflow = effectiveWorkflow(brain.config?.workflow, hasFeature(workspacePlan, 'workflow.review'))
  const actor = actorFromEmail(session.user.email)
  const decision = await resolveReleaseDecision({ projectId, workflow, policy: brain.approvalPolicy, createdBy: actor })
  if (!decision.allowed) {
    throw createError({
      statusCode: 403,
      message: errorMessage('deploy.approval_required'),
      data: { approval: decision },
    })
  }

  const startedAt = new Date().toISOString()
  const result = await triggerProjectDeploy({ projectId, workspaceId, reason: 'manual', immediate: true })
  if (!result)
    throw createError({ statusCode: 404, message: errorMessage('deploy.not_configured') })
  if (!result.ok)
    throw createError({ statusCode: 502, message: errorMessage('deploy.trigger_failed', { status: String(result.status) }) })

  // A release that fired is a release whose approvals are spent: the next one
  // is a new decision, not a re-run of this one.
  if (workflow === 'review') {
    const releasePlan = await buildReleasePlan({ projectId, target: RELEASE_TARGET, reason: 'manual', createdBy: actor })
    const grants = (await db.listApprovals(projectId, RELEASE_TARGET)).map(r => grantFromRow(r as Record<string, unknown>))
    await db.recordReceipt({
      projectId,
      workspaceId,
      target: RELEASE_TARGET,
      planHash: releasePlan.plan_hash,
      receipt: buildReceipt({
        plan: releasePlan,
        grants,
        actor,
        status: 'completed',
        startedAt,
        finishedAt: new Date().toISOString(),
      }) as unknown as Record<string, unknown>,
    }).catch(() => { /* the deploy fired; losing the record must not undo it */ })
    await db.clearApprovals(projectId, RELEASE_TARGET).catch(() => {})
  }

  return result
})
