import type { ApprovalGrant, ApprovalPolicyFile } from '@contentrain/types'
import type { BranchReview } from '../../shared/utils/branch-review'
import { describe, expect, it } from 'vitest'
import { evaluatePlan } from '../../server/utils/approval-gate'
import { actorFromEmail, branchRisk, buildBranchPlan, buildReceipt, grantFromRow } from '../../server/utils/execution-plan'

/**
 * The plan a pending branch stands for is derived, not stored — which is what
 * makes an approval expire by itself when the branch moves. These pin that:
 * the same branch produces the same hash, a changed branch produces another,
 * and a grant given for the old one stops counting without anything having
 * been invalidated by hand.
 */

function review(over: Partial<BranchReview> = {}): BranchReview {
  return {
    branch: 'cr/content/posts/en/1234567890-abcd',
    info: { scope: 'content', modelId: 'posts', modelName: 'Posts', locale: 'en', timestamp: 1234567890, updatedBy: 'author@example.com', updatedAt: '2026-09-11T10:00:00.000Z' },
    groups: [{
      modelId: 'posts',
      modelName: 'Posts',
      kind: 'collection',
      locale: 'en',
      omittedEntries: 0,
      entries: [{ kind: 'modified', entryId: 'e1', title: 'One', fields: [], statusBefore: null, statusAfter: null, updatedBy: 'author@example.com', updatedAt: '2026-09-11T10:00:00.000Z' }],
    }],
    schema: [],
    settings: [],
    unclassified: [],
    summary: { added: 0, updated: 1, removed: 0 },
    canMerge: true,
    canReject: true,
    ...over,
  }
}

const SCHEMA_CHANGE = {
  kind: 'modified' as const,
  modelId: 'posts',
  modelName: 'Posts',
  added: [],
  removed: [],
  retyped: [],
  titleFieldBefore: null,
  titleFieldAfter: null,
  destructive: false,
}

describe('branch risk', () => {
  it('reads the same account of the change the panel shows', () => {
    expect(branchRisk(review())).toBe('low_risk_content')
    expect(branchRisk(review({ summary: { added: 0, updated: 3, removed: 0 } }))).toBe('bulk_content')
    // A removal is never the lowest rung: the entry is gone from the branch,
    // and the person who notices is rarely the one who asked for it.
    expect(branchRisk(review({ summary: { added: 0, updated: 0, removed: 1 } }))).toBe('bulk_content')
    expect(branchRisk(review({ schema: [SCHEMA_CHANGE] }))).toBe('destructive_schema')
    expect(branchRisk(review({ settings: [{ area: 'locales', items: [{ key: 'supported', values: ['tr'] }] }] }))).toBe('destructive_schema')
    // Vocabulary is terms, not structure — it does not lift the class.
    expect(branchRisk(review({ settings: [{ area: 'vocabulary', items: [{ key: 'x', values: ['y'] }] }] }))).toBe('low_risk_content')
  })
})

describe('plan hash', () => {
  it('is the same for an unchanged branch and different for a changed one', async () => {
    const a = await buildBranchPlan(review())
    const b = await buildBranchPlan(review())
    expect(a.plan_hash).toBe(b.plan_hash)
    expect(a.plan_hash).toHaveLength(64)

    const wider = await buildBranchPlan(review({ summary: { added: 1, updated: 1, removed: 0 } }))
    expect(wider.plan_hash).not.toBe(a.plan_hash)
  })

  it('names what the change touches, so an approver reads one list', async () => {
    const plan = await buildBranchPlan(review())
    expect(plan.scope.models).toEqual(['posts'])
    expect(plan.scope.locales).toEqual(['en'])
    expect(plan.scope.entries).toEqual(['posts:e1'])
    expect(plan.created_by?.id).toBe('author@example.com')
  })
})

function grant(over: Partial<ApprovalGrant> & { plan_hash: string }): ApprovalGrant {
  return {
    gate: 'change',
    approver: actorFromEmail('reviewer@example.com', 'admin'),
    approved_at: '2026-09-11T11:00:00.000Z',
    ...over,
  }
}

describe('deciding a branch', () => {
  it('holds a branch with no decisions, and lets it through once one is given', async () => {
    const plan = await buildBranchPlan(review())
    const held = evaluatePlan({ workflow: 'review', plan, policy: null, grants: [] })
    expect(held.allowed).toBe(false)
    expect(held.requirements[0]).toMatchObject({ gate: 'change', remaining: 1 })

    const signed = evaluatePlan({ workflow: 'review', plan, policy: null, grants: [grant({ plan_hash: plan.plan_hash })] })
    expect(signed.allowed).toBe(true)
    expect(signed.requirements[0]?.approvers).toEqual(['reviewer@example.com'])
  })

  it('stops counting a decision once the branch has moved', async () => {
    // The property the derived plan buys: nothing invalidates the grant, the
    // hash simply stops matching.
    const before = await buildBranchPlan(review())
    const after = await buildBranchPlan(review({ summary: { added: 2, updated: 1, removed: 0 } }))
    const decision = evaluatePlan({ workflow: 'review', plan: after, policy: null, grants: [grant({ plan_hash: before.plan_hash })] })

    expect(decision.allowed).toBe(false)
    expect(decision.rejectedGrants).toEqual([{ approver: 'reviewer@example.com', reason: 'plan_hash_mismatch' }])
  })

  it('does not count a review of an older branch tip', async () => {
    const plan = await buildBranchPlan(review())
    const decision = evaluatePlan({
      workflow: 'review',
      plan,
      policy: null,
      grants: [grant({ plan_hash: plan.plan_hash, commit_sha: 'old-sha' })],
      commitSha: 'new-sha',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.rejectedGrants[0]?.reason).toBe('commit_mismatch')
  })

  it('lets the author sign by default, and stops when the project says four eyes', async () => {
    // The unconfigured default relaxes exactly this: a one-person project must
    // not end up with a Merge button nobody can press. A project that means
    // four-eyes states it.
    const plan = await buildBranchPlan(review())
    const self = [grant({ plan_hash: plan.plan_hash, approver: actorFromEmail('author@example.com', 'owner') })]

    expect(evaluatePlan({ workflow: 'review', plan, policy: null, grants: self }).allowed).toBe(true)

    const fourEyes: ApprovalPolicyFile = {
      version: 1,
      allow_self_approval: false,
      rules: [{ risk: 'low_risk_content', gate: 'change', mode: 'single' }],
    }
    const strict = evaluatePlan({ workflow: 'review', plan, policy: fourEyes, grants: self })
    expect(strict.allowed).toBe(false)
    expect(strict.rejectedGrants[0]?.reason).toBe('self_approval')
  })

  it('asks nothing of an auto-merge project, whatever the policy says', async () => {
    const plan = await buildBranchPlan(review({ schema: [SCHEMA_CHANGE] }))
    const decision = evaluatePlan({ workflow: 'auto-merge', plan, policy: null, grants: [] })
    expect(decision.allowed).toBe(true)
    expect(decision.requirements).toEqual([])
  })
})

describe('stored grants and receipts', () => {
  it('reads a stored row back as the grant the evaluator understands', () => {
    const g = grantFromRow({
      gate: 'change',
      plan_hash: 'abc',
      commit_sha: 'sha-1',
      approver_email: 'Reviewer@Example.com',
      approver_role: 'admin',
      approved_at: '2026-09-11T11:00:00.000Z',
      note: 'looks right',
    })
    // Identity is case-insensitive: the evaluator compares ids, and an address
    // typed with a capital is the same person.
    expect(g.approver.id).toBe('reviewer@example.com')
    expect(g).toMatchObject({ gate: 'change', plan_hash: 'abc', commit_sha: 'sha-1', note: 'looks right' })
  })

  it('keeps its own copy of the approvals that permitted the run', async () => {
    // The grants are cleared when the branch lands; a record whose evidence can
    // be deleted out from under it is not a record.
    const plan = await buildBranchPlan(review())
    const receipt = buildReceipt({
      plan,
      grants: [grant({ plan_hash: plan.plan_hash })],
      actor: actorFromEmail('merger@example.com', 'owner'),
      status: 'completed',
      startedAt: '2026-09-11T11:00:00.000Z',
      finishedAt: '2026-09-11T11:00:02.000Z',
    })
    expect(receipt.plan_hash).toBe(plan.plan_hash)
    expect(receipt.approvals).toHaveLength(1)
    expect(receipt.applied).toEqual(plan.scope)
    expect(receipt.actor.id).toBe('merger@example.com')
  })
})
