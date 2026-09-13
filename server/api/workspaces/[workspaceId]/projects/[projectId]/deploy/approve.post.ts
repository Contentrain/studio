/**
 * Record a decision on this project's next release.
 *
 * Separate from approving content on purpose. Approving a branch answers
 * "are these words right"; approving a release answers "is now the moment to
 * put them in front of the public". They are different questions, they are
 * often different people, and a policy can require a different set for each —
 * so a release carries its own plan, its own gate and its own grants.
 *
 * POST   …/deploy/approve   { note? }
 * DELETE …/deploy/approve
 */
import { evaluatePlan, gateForPlan } from '~~/server/utils/approval-gate'
import { effectiveWorkflow } from '~~/server/utils/branch-approval'
import { actorFromEmail, buildReleasePlan, grantFromRow } from '~~/server/utils/execution-plan'
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
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const body = await readBody<{ note?: string }>(event).catch(() => ({} as { note?: string }))
  const { git, contentRoot, workspace } = await resolveProjectContext(workspaceId, projectId)
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const workflow = effectiveWorkflow(brain.config?.workflow, hasFeature(plan, 'workflow.review'))
  if (workflow !== 'review')
    throw createError({ statusCode: 400, message: errorMessage('branches.approval_not_required') })

  const releasePlan = await buildReleasePlan({
    projectId,
    target: RELEASE_TARGET,
    reason: 'manual',
    createdBy: actorFromEmail(email, typeof role === 'string' ? role : undefined),
  })

  const before = evaluatePlan({
    workflow,
    plan: releasePlan,
    policy: brain.approvalPolicy,
    grants: (await db.listApprovals(projectId, RELEASE_TARGET)).map(r => grantFromRow(r as Record<string, unknown>)),
  })

  await db.recordApproval({
    projectId,
    workspaceId,
    target: RELEASE_TARGET,
    gate: gateForPlan(before),
    planHash: releasePlan.plan_hash,
    approverId: session.user.id,
    approverEmail: email,
    approverRole: typeof role === 'string' ? role : null,
    note: body?.note ?? null,
  })

  return { approval: await resolveReleaseDecision({ projectId, workflow, policy: brain.approvalPolicy, createdBy: actorFromEmail(email) }) }
})
