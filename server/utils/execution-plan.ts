/**
 * The plan behind an approval, and the receipt behind a run.
 *
 * S-05 put the *decision* on the evaluator but left the grants empty: a policy
 * could say "one review on the diff" and a person clicking Merge in the panel
 * still landed the branch without anything recording that a review happened.
 * Approving is that missing half — a grant is given for a specific plan, and
 * the merge is evaluated against the grants it actually has.
 *
 * **There is no plan table, on purpose.** A pending branch's plan is derived
 * from the branch itself — the same `BranchReview` the panel renders — so it is
 * recomputed rather than stored, and `computePlanHash` is what ties a grant to
 * it. That gives the property a stored plan would have had to enforce by hand:
 * push another commit to the branch and its scope, its risk or its entries
 * change, the hash changes with them, and every approval collected for the old
 * shape stops counting. Nobody has to remember to invalidate anything.
 *
 * Identity is the **email**, for both the author and the approver. The
 * evaluator only ever compares ids, and email is the one identifier that
 * appears on both sides — Studio's session carries it and a content write
 * stamps it into meta as `updated_by`. Using profile uuids for approvers and
 * emails for authors would make self-approval undetectable, which is the one
 * check that has to work.
 */

import type { ActorRef, ApprovalGrant, ExecutionPlan, ExecutionReceipt, ExecutionScope, RiskClass } from '@contentrain/types'
import { computePlanHash } from '@contentrain/types'
import type { BranchReview } from '../../shared/utils/branch-review'

const PLAN_VERSION = 1

/** An actor the evaluator can compare — see the module docstring on identity. */
export function actorFromEmail(email: string | null | undefined, role?: string): ActorRef {
  return { kind: 'human', id: (email ?? 'unknown').toLowerCase(), ...(email ? { name: email } : {}), ...(role ? { role } : {}) }
}

/**
 * The class a pending branch is judged at.
 *
 * Reads the same review the panel shows, so what a reviewer sees and what the
 * policy weighed are the same account of the change:
 *
 * - a schema or project-settings change is `destructive_schema` — the model
 *   contract is what every reader depends on, and a removal or retype can
 *   outlive the content that fit it;
 * - a removal, or more than one entry in one branch, is `bulk_content`;
 * - anything else is `low_risk_content`.
 */
export function branchRisk(review: BranchReview): RiskClass {
  if (review.schema.length > 0) return 'destructive_schema'
  if (review.settings.some(s => s.area === 'locales' || s.area === 'workflow' || s.area === 'project')) return 'destructive_schema'
  const entries = review.summary.added + review.summary.updated + review.summary.removed
  if (review.summary.removed > 0 || entries > 1) return 'bulk_content'
  return 'low_risk_content'
}

function branchScope(review: BranchReview): ExecutionScope {
  const models = new Set<string>()
  const locales = new Set<string>()
  const entries = new Set<string>()
  for (const group of review.groups) {
    models.add(group.modelId)
    if (group.locale) locales.add(group.locale)
    for (const entry of group.entries) entries.add(`${group.modelId}:${entry.entryId}`)
  }
  for (const schema of review.schema) models.add(schema.modelId)
  return {
    ...(models.size ? { models: [...models].sort() } : {}),
    ...(locales.size ? { locales: [...locales].sort() } : {}),
    ...(entries.size ? { entries: [...entries].sort() } : {}),
  }
}

function branchIntent(review: BranchReview): string {
  const { added, updated, removed } = review.summary
  const parts = [
    added ? `${added} added` : null,
    updated ? `${updated} updated` : null,
    removed ? `${removed} removed` : null,
    review.schema.length ? `${review.schema.length} model definition${review.schema.length > 1 ? 's' : ''}` : null,
  ].filter(Boolean)
  return `Merge ${review.branch} into contentrain${parts.length ? ` — ${parts.join(', ')}` : ''}`
}

/**
 * The plan a pending branch stands for. Deterministic in the review, so two
 * calls on an unchanged branch produce the same `plan_hash`, and a new commit
 * produces a different one.
 */
export async function buildBranchPlan(review: BranchReview): Promise<ExecutionPlan> {
  const risk = branchRisk(review)
  const scope = branchScope(review)
  const intent = branchIntent(review)
  const plan: ExecutionPlan = {
    version: PLAN_VERSION,
    id: review.branch,
    plan_hash: '',
    intent,
    risk,
    steps: [{ id: 'merge', tool: 'merge_branch', summary: intent, risk, ...(Object.keys(scope).length ? { scope } : {}) }],
    scope,
    created_by: actorFromEmail(review.info.updatedBy),
  }
  return { ...plan, plan_hash: await computePlanHash(plan) }
}

/**
 * The plan a deploy stands for — S-10's separate question.
 *
 * Approving content is not permission to put it in front of the public: one is
 * about whether the words are right, the other about whether now is the moment.
 * So a release is its own plan at `deployment` risk, with its own gate, and a
 * policy can require a different set of people for it.
 */
export async function buildReleasePlan(input: {
  projectId: string
  target: string
  reason: string
  createdBy: ActorRef
}): Promise<ExecutionPlan> {
  const intent = `Deploy ${input.target} (${input.reason})`
  const scope: ExecutionScope = { providers: [input.target] }
  const plan: ExecutionPlan = {
    version: PLAN_VERSION,
    id: `release:${input.projectId}`,
    plan_hash: '',
    intent,
    risk: 'deployment',
    steps: [{ id: 'deploy', tool: 'deploy', summary: intent, risk: 'deployment', scope }],
    scope,
    created_by: input.createdBy,
  }
  return { ...plan, plan_hash: await computePlanHash(plan) }
}

/** A stored approval row read back as the grant the evaluator understands. */
export function grantFromRow(row: Record<string, unknown>): ApprovalGrant {
  return {
    gate: row.gate as ApprovalGrant['gate'],
    plan_hash: String(row.plan_hash),
    ...(row.commit_sha ? { commit_sha: String(row.commit_sha) } : {}),
    approver: {
      kind: 'human',
      id: String(row.approver_email).toLowerCase(),
      ...(row.approver_email ? { name: String(row.approver_email) } : {}),
      ...(row.approver_role ? { role: String(row.approver_role) } : {}),
    },
    approved_at: new Date(String(row.approved_at)).toISOString(),
    ...(row.note ? { note: String(row.note) } : {}),
  }
}

/**
 * What actually ran.
 *
 * The receipt carries the approvals rather than pointing at them: the grants
 * are cleared when the branch lands, and an audit record whose evidence can be
 * deleted out from under it is not a record. `approversFor(receipt, gate)`
 * reads them back — there is deliberately no `release_approved_by` column,
 * because the same fact in two places is a fact that can disagree with itself.
 */
export function buildReceipt(input: {
  plan: ExecutionPlan
  grants: readonly ApprovalGrant[]
  actor: ActorRef
  status: ExecutionReceipt['status']
  startedAt: string
  finishedAt: string
  /** What was actually touched. Defaults to the plan's scope when the run did what it said. */
  applied?: ExecutionScope
  error?: { code: string, message: string }
}): ExecutionReceipt {
  return {
    version: PLAN_VERSION,
    id: `${input.plan.id}@${input.plan.plan_hash.slice(0, 12)}`,
    plan_id: input.plan.id,
    plan_hash: input.plan.plan_hash,
    status: input.status,
    actor: input.actor,
    applied: input.applied ?? input.plan.scope,
    approvals: [...input.grants],
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    ...(input.error ? { error: input.error } : {}),
  }
}
