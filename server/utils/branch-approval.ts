/**
 * The approval state of one pending branch: its plan, the grants it has
 * collected, and what the policy still wants.
 *
 * Three routes need the same four steps — the panel that renders the state, the
 * button that adds a decision to it, and the merge that has to honour it — and
 * a merge deciding from a differently-assembled plan than the one the reviewer
 * approved would be the exact bug this whole path exists to prevent. So the
 * assembly lives here once.
 */

import type { ApprovalGrant, ApprovalPolicyFile, ExecutionPlan } from '@contentrain/types'
import type { H3Event } from 'h3'
import type { GitProvider } from '../providers/git'
import { buildBranchReview } from './branch-review'
import type { BranchReview } from '../../shared/utils/branch-review'
import type { PlanDecision } from '../../shared/utils/approval'
import { evaluatePlan } from './approval-gate'
import { buildBranchPlan, grantFromRow } from './execution-plan'

export interface BranchApproval {
  plan: ExecutionPlan
  decision: PlanDecision
  grants: ApprovalGrant[]
}

/**
 * Resolve the effective workflow the same way every other caller does: review
 * is honoured only when the plan grants the feature *and* the project opted in.
 */
export function effectiveWorkflow(configWorkflow: string | undefined, planHasReview: boolean): string {
  if (!planHasReview) return 'auto-merge'
  return configWorkflow === 'review' ? 'review' : 'auto-merge'
}

export async function resolveBranchApproval(input: {
  projectId: string
  review: BranchReview
  workflow: string
  policy: ApprovalPolicyFile | null
  /** The branch tip. A `change` grant that reviewed another tip does not count. */
  commitSha?: string
  now?: string
}): Promise<BranchApproval> {
  const plan = await buildBranchPlan(input.review)

  // An auto-merge project collects nothing and is asked nothing; skipping the
  // read keeps the merge path as cheap as it was before approvals existed.
  if (input.workflow !== 'review') {
    return { plan, grants: [], decision: evaluatePlan({ workflow: input.workflow, plan, grants: [] }) }
  }

  const rows = await useDatabaseProvider().listApprovals(input.projectId, input.review.branch)
  const grants = rows.map(row => grantFromRow(row as Record<string, unknown>))
  const decision = evaluatePlan({
    workflow: input.workflow,
    plan,
    policy: input.policy,
    grants,
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    ...(input.now ? { now: input.now } : {}),
  })
  return { plan, decision, grants }
}

/**
 * Build the semantic review of a pending branch — the same account of the
 * change the panel renders, and therefore the same one the plan is derived
 * from. Assembling it a second way somewhere else is how a reviewer and a
 * merge end up disagreeing about what they were looking at.
 */
export async function loadBranchReview(input: {
  git: GitProvider
  contentRoot: string
  projectId: string
  branch: string
  canMerge: boolean
  canReject: boolean
  baseBranch?: string
}): Promise<BranchReview> {
  const baseBranch = input.baseBranch ?? 'contentrain'
  const files = await input.git.getBranchDiff(input.branch, baseBranch)
  const brain = await getOrBuildBrainCache(input.git, input.contentRoot, input.projectId)

  const read = async (path: string, ref: string): Promise<string | null> => {
    try {
      return await input.git.readFile(path, ref)
    }
    catch {
      // Absent at that ref — a create or a delete, not an error.
      return null
    }
  }

  return buildBranchReview({
    branch: input.branch,
    files,
    read,
    baseRef: baseBranch,
    branchRef: input.branch,
    models: brain.models,
    config: brain.config,
    contentRoot: input.contentRoot,
    relationSource: (modelId, locale) => brain.content.get(`${modelId}:${locale}`) ?? null,
    canMerge: input.canMerge,
    canReject: input.canReject,
  })
}

/** The branch tip, or undefined when the branch is gone. */
export async function branchTip(git: GitProvider, branch: string): Promise<string | undefined> {
  try {
    const branches = await git.listBranches()
    return branches.find(b => b.name === branch)?.sha
  }
  catch {
    return undefined
  }
}

/**
 * Everything the approve/withdraw routes need, resolved once: the branch is
 * real, the caller may review it, the project actually asks for approvals, and
 * the plan can be rebuilt on demand — before the decision and after it, from
 * the same review, so the answer the caller gets back is the answer the merge
 * will give.
 */
export async function requireBranchApprovalContext(event: H3Event): Promise<{
  projectId: string
  workspaceId: string
  branch: string
  userId: string
  email: string
  role: string
  commitSha?: string
  resolve: () => Promise<BranchApproval>
}> {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  // cr/* branch names carry slashes and arrive percent-encoded.
  const branch = getRouterParam(event, 'branch', { decode: true })

  if (!workspaceId || !projectId || !branch)
    throw createError({ statusCode: 400, message: errorMessage('validation.branch_params_required') })
  if (!branch.startsWith('cr/'))
    throw createError({ statusCode: 400, message: errorMessage('branches.contentrain_only') })

  // Approving is a reviewer's act — the same gate the merge answers to. A
  // policy may narrow it further by role; the evaluator reports that as
  // `role_not_permitted` rather than this route guessing at it.
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('merge_branch'))
    throw createError({ statusCode: 403, message: errorMessage('branches.merge_forbidden') })

  const email = session.user.email
  if (!email)
    throw createError({ statusCode: 400, message: errorMessage('branches.approval_needs_identity') })

  const { git, contentRoot, workspace } = await resolveProjectContext(workspaceId, projectId)
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const workflow = effectiveWorkflow(brain.config?.workflow, hasFeature(plan, 'workflow.review'))
  if (workflow !== 'review')
    throw createError({ statusCode: 400, message: errorMessage('branches.approval_not_required') })

  const review = await loadBranchReview({ git, contentRoot, projectId, branch, canMerge: true, canReject: true })
  const commitSha = await branchTip(git, branch)

  return {
    projectId,
    workspaceId,
    branch,
    userId: session.user.id,
    email,
    role: permissions.workspaceRole,
    ...(commitSha ? { commitSha } : {}),
    resolve: () => resolveBranchApproval({ projectId, review, workflow, policy: brain.approvalPolicy, ...(commitSha ? { commitSha } : {}) }),
  }
}
