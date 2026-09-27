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

import type { ActorRef, ApprovalGrant, ApprovalPolicyFile, ExecutionPlan } from '@contentrain/types'
import type { H3Event } from 'h3'
import type { GitProvider } from '../providers/git'
import { buildBranchReview } from './branch-review'
import type { BranchReview } from '../../shared/utils/branch-review'
import type { PlanDecision } from '../../shared/utils/approval'
import type { WriteSignals } from './approval-gate'
import { evaluatePlan } from './approval-gate'
import { buildBranchPlan, buildReceipt, contentLoss, grantFromRow } from './execution-plan'

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

/**
 * What a write's own branch says about it — the half of {@link WriteSignals}
 * the payload cannot answer.
 *
 * A save is gated right after it commits, before the branch is ever merged,
 * and the merge is gated later from the review of the same branch. Counting
 * emptied fields and dropped list items from that same review here is what
 * keeps the two answers from drifting: a save that clears `seo.title` or
 * deletes two FAQ items is `bulk_content` when it is written and again when
 * someone presses Merge.
 *
 * A branch that cannot be read back reports `unreadBranch` rather than zero —
 * an unanswered question lifts the write, it does not let it through.
 */
export async function branchWriteSignals(input: {
  git: GitProvider
  contentRoot: string
  projectId: string
  branch: string
}): Promise<Pick<WriteSignals, 'emptiedFields' | 'removedItems' | 'unreadBranch'>> {
  try {
    const review = await loadBranchReview({ ...input, canMerge: false, canReject: false })
    return contentLoss(review)
  }
  catch {
    return { unreadBranch: true }
  }
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
 * The approval a merge of a pending branch has to honour, or null on a project
 * that asks for none.
 *
 * Every merge of someone's pending branch answers to this — the Merge button
 * and the chat agent's `merge_branch` alike. The agent once merged a branch
 * the panel showed at 0/1 because it asked nothing at all; a second way to
 * merge that skips the question is a way around the review.
 */
export async function resolveMergeApproval(input: {
  git: GitProvider
  contentRoot: string
  projectId: string
  branch: string
  workflow: string
  policy: ApprovalPolicyFile | null
}): Promise<BranchApproval | null> {
  // An auto-merge project asks nobody's permission — building the review and
  // reading the grants to answer a question it never poses would only make the
  // merge slower.
  if (input.workflow !== 'review') return null
  const review = await loadBranchReview({ git: input.git, contentRoot: input.contentRoot, projectId: input.projectId, branch: input.branch, canMerge: true, canReject: true })
  const commitSha = await branchTip(input.git, input.branch)
  return resolveBranchApproval({
    projectId: input.projectId,
    review,
    workflow: input.workflow,
    policy: input.policy,
    ...(commitSha ? { commitSha } : {}),
  })
}

/**
 * Keep the receipt of a merge an approval allowed, then clear its grants.
 *
 * The receipt outlives the grants: they are cleared with the branch, and an
 * audit record whose evidence can be deleted out from under it is not one.
 * The merge already happened, so a failure to record must not undo it.
 */
export async function recordMergeReceipt(input: {
  projectId: string
  workspaceId: string
  branch: string
  approval: BranchApproval
  actor: ActorRef
  startedAt: string
}): Promise<void> {
  const db = useDatabaseProvider()
  const receipt = buildReceipt({
    plan: input.approval.plan,
    grants: input.approval.grants,
    actor: input.actor,
    status: 'completed',
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
  })
  await db.recordReceipt({
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    target: input.branch,
    planHash: input.approval.plan.plan_hash,
    receipt: receipt as unknown as Record<string, unknown>,
  }).catch(() => {})
  await db.clearApprovals(input.projectId, input.branch).catch(() => {})
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
