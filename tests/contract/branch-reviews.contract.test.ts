import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { branchReviewMethods } from '../../server/providers/postgres-db/branch-reviews'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

const BRANCH = 'cr/content/posts/en/1755612345-a3f2'

describe('postgres-db branch reviews (contract)', () => {
  const methods = branchReviewMethods()
  let user: SeededUser
  let projectId: string

  beforeAll(async () => {
    user = await seedUser('branch-reviews')
    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/branch-reviews-fixture') RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('request → get/list → re-request replaces → resolve hides → clear removes', async () => {
    const first = await methods.requestBranchChanges({ projectId, workspaceId: user.workspaceId, branch: BRANCH, comment: 'Shorten the intro', requestedBy: user.userId })
    expect(first.status).toBe('changes_requested')
    expect(first.requested_by).toBe(user.userId)

    expect((await methods.getBranchChangeRequest(projectId, BRANCH))?.comment).toBe('Shorten the intro')
    expect((await methods.listBranchChangeRequests(projectId)).map(r => r.branch)).toEqual([BRANCH])

    // A second request on the same branch replaces the comment (one row per branch).
    const second = await methods.requestBranchChanges({ projectId, workspaceId: user.workspaceId, branch: BRANCH, comment: 'And fix the date', requestedBy: user.userId })
    expect(second.comment).toBe('And fix the date')
    expect(second.resolved_at).toBeNull()
    const count = await sql<{ n: string }>`SELECT count(*)::text AS n FROM public.branch_reviews WHERE project_id = ${projectId}`.execute(getDb())
    expect(count.rows[0]!.n).toBe('1')

    await methods.resolveBranchChangeRequest(projectId, BRANCH, user.userId)
    expect(await methods.getBranchChangeRequest(projectId, BRANCH)).toBeNull()
    expect(await methods.listBranchChangeRequests(projectId)).toEqual([])
    const resolved = await sql<{ status: string, resolved_by: string | null }>`SELECT status, resolved_by FROM public.branch_reviews WHERE project_id = ${projectId} AND branch = ${BRANCH}`.execute(getDb())
    expect(resolved.rows[0]).toEqual({ status: 'resolved', resolved_by: user.userId })

    // Re-requesting a resolved branch reopens it.
    await methods.requestBranchChanges({ projectId, workspaceId: user.workspaceId, branch: BRANCH, comment: 'Once more', requestedBy: user.userId })
    expect((await methods.getBranchChangeRequest(projectId, BRANCH))?.comment).toBe('Once more')

    await methods.clearBranchChangeRequest(projectId, BRANCH)
    const gone = await sql<{ n: string }>`SELECT count(*)::text AS n FROM public.branch_reviews WHERE project_id = ${projectId}`.execute(getDb())
    expect(gone.rows[0]!.n).toBe('0')
  })
})
