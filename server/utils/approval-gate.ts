/**
 * Whether an agent write may merge itself.
 *
 * The question used to be answered by role: under the `review` workflow an
 * owner or admin merged, an editor did not. That reads the wrong thing. Who
 * asked for a change says nothing about what the change does — an owner
 * deleting a model and an owner fixing a typo took the same path, and no
 * project could say otherwise.
 *
 * So the decision moves to `@contentrain/types`' evaluator, which answers from
 * the action: its risk class, its scope, and the project's own policy in
 * `.contentrain/approval-policies.json`. The policy lives on the branch,
 * because a policy that lives only in a database can be changed after a plan is
 * built and before it is approved.
 *
 * Two things this does not change:
 *
 * - **`workflow` still decides whether the evaluator is consulted at all.** An
 *   `auto-merge` project merges without asking; the evaluator is the `review`
 *   workflow's rule, not a second workflow.
 * - **Studio's own merge controls are untouched.** A held branch is still
 *   merged by hand from the branch review panel. The evaluator governs what the
 *   agent does unattended, which is the only thing that was ever automatic.
 *
 * With no grants to weigh — approving a plan is S-10's surface, not this one —
 * a project with no policy file falls to {@link STUDIO_DEFAULT_POLICY}, which
 * holds every write above `read_only` for one review. That is the intended meaning of
 * the review workflow; a project that wants the old behaviour writes a rule
 * with `mode: 'auto'` for the classes it trusts.
 */

import type { ActorRef, ApprovalGrant, ApprovalPolicyFile, ExecutionPlan, ExecutionScope, RiskClass } from '@contentrain/types'
import type { PlanDecision } from '../../shared/utils/approval'
import { APPROVAL_GATES, APPROVAL_MODES, computePlanHash, DEFAULT_APPROVAL_POLICY, evaluateApproval, RISK_CLASSES } from '@contentrain/types'

/** The plan contract version this file builds against. */
const PLAN_VERSION = 1

/**
 * What applies when a project has written no policy of its own.
 *
 * The ecosystem default asks for one decision on the diff and, like any
 * four-eyes rule, does not let the author be that decision. That is right for a
 * team and wrong for the projects most likely to switch the review workflow on
 * without writing a policy file: on a one-person project it produces a Merge
 * button that can never be pressed and an approval that reports
 * `self_approval`, which reads as a broken product rather than as a rule.
 *
 * So the unconfigured default relaxes exactly one thing — who may be the
 * approver — and keeps everything else. An approval is still required, still
 * recorded, and still tied to the diff it was given for; that is already
 * strictly more than the nothing that used to happen. A project that means
 * four-eyes writes `"allow_self_approval": false` in
 * `.contentrain/approval-policies.json` and gets it, which is the right way
 * round: the stricter rule is the one someone states on purpose.
 */
export const STUDIO_DEFAULT_POLICY: ApprovalPolicyFile = {
  ...DEFAULT_APPROVAL_POLICY,
  allow_self_approval: true,
}

/**
 * Risk floor per write tool.
 *
 * The class describes the *kind* of thing being changed, not the size of one
 * call: a model write is schema whether it adds a field or removes one, because
 * a policy author reasons about "who may change the schema", not about which
 * schema edits happen to be reversible. Size enters separately —
 * {@link toolRisk} lifts a multi-entry content write to `bulk_content`.
 *
 * A tool absent from this map is a read, and reads are `read_only`: the map is
 * the allowlist, so a new write tool that nobody classified is caught by
 * {@link assertClassifiedWriteTools} in the test suite rather than defaulting
 * into the lowest rung in production.
 */
const TOOL_RISK: Record<string, RiskClass> = {
  save_content: 'low_risk_content',
  approve_submission: 'low_risk_content',
  update_status: 'low_risk_content',
  vocabulary: 'low_risk_content',
  // A delete never sits on the lowest rung: the entry is gone from the branch,
  // and the person who notices is rarely the person who asked for it.
  delete_content: 'bulk_content',
  // Locale work writes across every entry of a model by construction.
  copy_locale: 'bulk_content',
  add_locale: 'bulk_content',
  save_model: 'destructive_schema',
  delete_model: 'destructive_schema',
}

/** The write tools this module classifies — the test suite holds it to the engine's list. */
export const CLASSIFIED_WRITE_TOOLS = Object.keys(TOOL_RISK)

export interface ToolScope {
  models?: string[]
  locales?: string[]
  entries?: string[]
}

/**
 * The class this call is evaluated at: the tool's floor, lifted to
 * `bulk_content` when one call touches more than one entry.
 */
export function toolRisk(tool: string, scope: ToolScope = {}): RiskClass {
  const floor = TOOL_RISK[tool]
  if (!floor) return 'read_only'
  if (floor === 'low_risk_content' && (scope.entries?.length ?? 0) > 1) return 'bulk_content'
  return floor
}

/**
 * Read a project's policy file, or `null` when it holds something this
 * evaluator would misread.
 *
 * Fail closed and say so: a malformed policy falls back to
 * {@link STUDIO_DEFAULT_POLICY} (stricter than most hand-written policies) and
 * raises a project-health warning, rather than being quietly ignored — a policy
 * that silently does not apply is worse than no policy, because someone
 * believes it is protecting them.
 */
export function parseApprovalPolicy(raw: string): { policy: ApprovalPolicyFile | null, error: string | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return { policy: null, error: 'not valid JSON' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { policy: null, error: 'not an object' }

  const file = parsed as Record<string, unknown>
  if (typeof file.version !== 'number')
    return { policy: null, error: '`version` is missing or not a number' }
  if (!Array.isArray(file.rules))
    return { policy: null, error: '`rules` is missing or not an array' }

  for (const [index, rule] of file.rules.entries()) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule))
      return { policy: null, error: `rule ${index} is not an object` }
    const r = rule as Record<string, unknown>
    if (!RISK_CLASSES.includes(r.risk as RiskClass))
      return { policy: null, error: `rule ${index} has an unknown \`risk\`: ${JSON.stringify(r.risk)}` }
    if (!APPROVAL_GATES.includes(r.gate as never))
      return { policy: null, error: `rule ${index} has an unknown \`gate\`: ${JSON.stringify(r.gate)}` }
    if (!APPROVAL_MODES.includes(r.mode as never))
      return { policy: null, error: `rule ${index} has an unknown \`mode\`: ${JSON.stringify(r.mode)}` }
  }

  if (file.default_mode !== undefined && !APPROVAL_MODES.includes(file.default_mode as never))
    return { policy: null, error: `unknown \`default_mode\`: ${JSON.stringify(file.default_mode)}` }

  return { policy: parsed as ApprovalPolicyFile, error: null }
}

/**
 * The entries one `save_content` call addresses: a document's slug, or the
 * keys of a collection payload. Used only to tell one entry from many —
 * {@link toolRisk} lifts a multi-entry write a rung.
 */
export function savedEntryIds(params: Record<string, unknown>): string[] {
  if (typeof params.slug === 'string' && params.slug) return [params.slug]
  const data = params.data
  if (data && typeof data === 'object' && !Array.isArray(data)) return Object.keys(data)
  return []
}

export interface MergeDecisionInput {
  /** The project's `workflow` config, already resolved against the plan's features. */
  workflow: string
  tool: string
  scope?: ToolScope
  /** The project's parsed policy, or `null` to fall back to the default. */
  policy?: ApprovalPolicyFile | null
  /** The branch tip being presented — a `change` grant must name it. */
  commitSha?: string
  /** ISO 8601 UTC. An input, never the clock, so a held decision stays explainable. */
  now?: string
}

/** What the agent should tell the user when a write is held. */
export interface HeldApproval {
  risk: RiskClass
  /** One line per blocker, from the evaluator. */
  reasons: string[]
  /** Gate + mode, what the rule asks for, and how many approvers are still missing. */
  outstanding: Array<{ gate: string, mode: string, min_approvals: number, remaining: number }>
}

export interface MergeDecision {
  allowed: boolean
  /** Spread into the tool result when the write is held; empty when it merges. */
  review: { approval?: HeldApproval }
}

const AGENT: ActorRef = { kind: 'agent', id: 'contentrain-agent', name: 'Contentrain agent' }

/**
 * The plan a single agent write stands for.
 *
 * One step, because one tool call is one step. The plan exists so the decision
 * is made against the same contract a multi-step plan will be (S-11), and so
 * the hash that pins an approval is computed the one way `computePlanHash`
 * computes it.
 */
export async function buildToolPlan(input: { tool: string, scope?: ToolScope, intent?: string }): Promise<ExecutionPlan> {
  const risk = toolRisk(input.tool, input.scope)
  const scope: ExecutionScope = {
    ...(input.scope?.models?.length ? { models: [...new Set(input.scope.models)] } : {}),
    ...(input.scope?.locales?.length ? { locales: [...new Set(input.scope.locales)] } : {}),
    ...(input.scope?.entries?.length ? { entries: [...new Set(input.scope.entries)] } : {}),
  }
  const intent = input.intent ?? `${input.tool} by the Contentrain agent`
  const plan: ExecutionPlan = {
    version: PLAN_VERSION,
    id: input.tool,
    plan_hash: '',
    intent,
    risk,
    steps: [{ id: `${input.tool}-1`, tool: input.tool, summary: intent, risk, ...(Object.keys(scope).length ? { scope } : {}) }],
    scope,
    created_by: AGENT,
  }
  return { ...plan, plan_hash: await computePlanHash(plan) }
}

/**
 * May this write merge itself?
 *
 * `auto-merge` projects never reach the evaluator. Everything else is decided
 * by the policy on the branch, with no grants: approving a plan is a surface
 * that does not exist yet, so under the default policy every write above
 * `read_only` is held for a person.
 */
export async function decideMerge(input: MergeDecisionInput): Promise<MergeDecision> {
  if (input.workflow !== 'review') return { allowed: true, review: {} }

  const plan = await buildToolPlan({ tool: input.tool, scope: input.scope })
  const decision = evaluateApproval({
    plan,
    policy: input.policy ?? STUDIO_DEFAULT_POLICY,
    grants: [],
    ...(input.commitSha ? { commit_sha: input.commitSha } : {}),
    ...(input.now ? { now: input.now } : {}),
  })

  if (decision.allowed) return { allowed: true, review: {} }

  return {
    allowed: false,
    review: {
      approval: {
        risk: decision.risk,
        reasons: decision.reasons,
        outstanding: decision.outstanding.map(o => ({ gate: o.gate, mode: o.mode, min_approvals: o.min_approvals, remaining: o.remaining })),
      },
    },
  }
}

// ─── Deciding a plan that has collected grants ───

/**
 * Decide a plan against the grants it has collected.
 *
 * `workflow` gates this the same way it gates {@link decideMerge}: an
 * `auto-merge` project is not asking anyone's permission, and turning its merge
 * button into an approval queue because a policy file happens to exist would be
 * a setting changing meaning behind the operator's back.
 */
export function evaluatePlan(input: {
  workflow: string
  plan: ExecutionPlan
  policy?: ApprovalPolicyFile | null
  grants: readonly ApprovalGrant[]
  commitSha?: string
  now?: string
}): PlanDecision {
  const base = {
    risk: input.plan.risk,
    planHash: input.plan.plan_hash,
    intent: input.plan.intent,
    scope: input.plan.scope,
  }
  if (input.workflow !== 'review')
    return { ...base, allowed: true, reasons: [], requirements: [], rejectedGrants: [] }

  const decision = evaluateApproval({
    plan: input.plan,
    policy: input.policy ?? STUDIO_DEFAULT_POLICY,
    grants: input.grants,
    ...(input.commitSha ? { commit_sha: input.commitSha } : {}),
    ...(input.now ? { now: input.now } : {}),
  })

  return {
    ...base,
    risk: decision.risk,
    allowed: decision.allowed,
    reasons: decision.reasons,
    requirements: decision.requirements.map(r => ({
      gate: r.gate,
      mode: r.mode,
      minApprovals: r.min_approvals,
      remaining: r.remaining,
      because: r.because,
      ...(r.roles?.length ? { roles: r.roles } : {}),
      approvers: r.approvers.map(a => a.name ?? a.id),
    })),
    rejectedGrants: decision.rejected_grants.map(r => ({
      approver: r.grant.approver.name ?? r.grant.approver.id,
      reason: r.reason,
    })),
  }
}

/**
 * The gate a plan's requirements land on, for routing an approval.
 *
 * A person pressing Approve is answering whatever the policy asked of them, so
 * the grant has to name that gate — a `release` decision recorded at the
 * `change` gate satisfies nothing and reads, to whoever gave it, like the
 * button did not work.
 */
export function gateForPlan(decision: PlanDecision): 'plan' | 'change' | 'release' {
  const outstanding = decision.requirements.find(r => r.remaining > 0)
  const gate = outstanding?.gate ?? decision.requirements[0]?.gate ?? 'change'
  return gate as 'plan' | 'change' | 'release'
}
