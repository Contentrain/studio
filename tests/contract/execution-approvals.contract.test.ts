import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executionApprovalMethods } from '../../server/providers/postgres-db/execution-approvals'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

const BRANCH = 'cr/content/posts/en/1755612345-a3f2'

describe('postgres-db execution approvals (contract)', () => {
  const methods = executionApprovalMethods()
  let user: SeededUser
  let projectId: string

  beforeAll(async () => {
    user = await seedUser('execution-approvals')
    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/approvals-fixture') RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('records one standing decision per person, and replaces it when the plan moves', async () => {
    const first = await methods.recordApproval({
      projectId,
      workspaceId: user.workspaceId,
      target: BRANCH,
      gate: 'change',
      planHash: 'hash-one',
      commitSha: 'sha-one',
      approverId: user.userId,
      approverEmail: 'Reviewer@Example.com',
      approverRole: 'admin',
      note: 'reads right',
    })
    // Identity is compared, so it is stored the way it is compared.
    expect(first.approver_email).toBe('reviewer@example.com')

    // Approving again after the branch moved replaces the stale grant rather
    // than stacking beside it: one person's opinion is one opinion.
    const second = await methods.recordApproval({
      projectId,
      workspaceId: user.workspaceId,
      target: BRANCH,
      gate: 'change',
      planHash: 'hash-two',
      commitSha: 'sha-two',
      approverId: user.userId,
      approverEmail: 'reviewer@example.com',
    })
    expect(second.plan_hash).toBe('hash-two')
    expect(second.note).toBeNull()

    const rows = await methods.listApprovals(projectId, BRANCH)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.commit_sha).toBe('sha-two')
  })

  it('keeps a release decision apart from a branch decision', async () => {
    // Content approval is not production permission: different target, and
    // neither can satisfy the other.
    await methods.recordApproval({
      projectId,
      workspaceId: user.workspaceId,
      target: 'release',
      gate: 'release',
      planHash: 'release-hash',
      approverId: user.userId,
      approverEmail: 'reviewer@example.com',
    })
    expect(await methods.listApprovals(projectId, 'release')).toHaveLength(1)
    expect(await methods.listApprovals(projectId, BRANCH)).toHaveLength(1)
  })

  it('withdraws one person\'s decision and clears a target wholesale', async () => {
    await methods.recordApproval({
      projectId,
      workspaceId: user.workspaceId,
      target: BRANCH,
      gate: 'change',
      planHash: 'hash-two',
      approverId: user.userId,
      approverEmail: 'second@example.com',
    })
    expect(await methods.listApprovals(projectId, BRANCH)).toHaveLength(2)

    await methods.deleteApproval(projectId, BRANCH, 'SECOND@example.com')
    expect(await methods.listApprovals(projectId, BRANCH)).toHaveLength(1)

    await methods.clearApprovals(projectId, BRANCH)
    expect(await methods.listApprovals(projectId, BRANCH)).toHaveLength(0)
    // Clearing a branch leaves the release queue alone.
    expect(await methods.listApprovals(projectId, 'release')).toHaveLength(1)
  })

  it('stores a receipt whole and reads it back newest first', async () => {
    const receipt = {
      version: 1,
      id: `${BRANCH}@abc`,
      plan_id: BRANCH,
      plan_hash: 'hash-two',
      status: 'completed',
      actor: { kind: 'human', id: 'merger@example.com' },
      applied: { models: ['posts'] },
      approvals: [{ gate: 'change', plan_hash: 'hash-two', approver: { kind: 'human', id: 'reviewer@example.com' }, approved_at: '2026-09-11T11:00:00.000Z' }],
      started_at: '2026-09-11T11:00:00.000Z',
      finished_at: '2026-09-11T11:00:02.000Z',
    }
    await methods.recordReceipt({ projectId, workspaceId: user.workspaceId, target: BRANCH, planHash: 'hash-two', receipt })
    await methods.recordReceipt({ projectId, workspaceId: user.workspaceId, target: 'release', planHash: 'release-hash', receipt: { ...receipt, plan_id: 'release' } })

    const rows = await methods.listReceipts(projectId, 10)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.target).toBe('release')
    // The approvals travel with the receipt: the grants themselves are cleared
    // when a branch lands, so the record keeps its own copy of the evidence.
    const stored = rows[1]!.receipt as typeof receipt
    expect(stored.approvals).toHaveLength(1)
    expect(stored.actor.id).toBe('merger@example.com')
  })
})
