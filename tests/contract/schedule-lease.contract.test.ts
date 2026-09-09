import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schedulingMethods } from '../../server/providers/postgres-db/scheduling'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('scheduled delivery leases', () => {
  const db = schedulingMethods()
  let user: SeededUser
  let projectId: string
  const now = new Date('2040-01-01T00:00:00Z')
  beforeAll(async () => {
    user = await seedUser('schedule-lease')
    const result = await sql<{ id: string }>`INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/schedule-lease') RETURNING id`.execute(getDb())
    projectId = result.rows[0]!.id
  })
  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('reclaims a crashed worker and rejects its stale acknowledgement', async () => {
    await db.upsertScheduledPublications([{ project_id: projectId, workspace_id: user.workspaceId,
      model_id: 'posts', entry_id: 'a', locale: 'en', kind: 'publish', fire_at: now.toISOString() }])
    const first = (await db.claimDueScheduledPublications(now, 200)).find(r => r.project_id === projectId)!
    expect(first.fired_at).toBeNull()
    expect(first.claim_token).toBeTruthy()
    expect((await db.claimDueScheduledPublications(now, 200)).filter(r => r.project_id === projectId)).toEqual([])
    const later = new Date(now.getTime() + 16 * 60_000)
    const second = (await db.claimDueScheduledPublications(later, 200)).find(r => r.project_id === projectId)!
    expect(second.claim_token).not.toBe(first.claim_token)
    expect(await db.settleScheduledPublication(String(first.id), String(first.claim_token), true, later)).toBe(false)
    expect(await db.settleScheduledPublication(String(second.id), String(second.claim_token), false, later)).toBe(true)
    expect((await db.claimDueScheduledPublications(later, 200)).filter(r => r.project_id === projectId)).toEqual([])
    const retryAt = new Date(later.getTime() + 61_000)
    const retry = (await db.claimDueScheduledPublications(retryAt, 200)).find(r => r.project_id === projectId)!
    expect(await db.settleScheduledPublication(String(retry.id), String(retry.claim_token), true, retryAt)).toBe(true)
    expect((await db.listPendingScheduledPublications(projectId))).toEqual([])
  })

  it('resaving invalidates an in-flight claim', async () => {
    const row = { project_id: projectId, workspace_id: user.workspaceId, model_id: 'posts',
      entry_id: 'b', locale: 'en', kind: 'publish' as const, fire_at: now.toISOString() }
    await db.upsertScheduledPublications([row])
    const claimed = (await db.claimDueScheduledPublications(now, 200)).find(r => r.project_id === projectId)!
    await db.upsertScheduledPublications([{ ...row, fire_at: '2040-02-01T00:00:00Z' }])
    expect(await db.settleScheduledPublication(String(claimed.id), String(claimed.claim_token), true, now)).toBe(false)
    expect((await db.listPendingScheduledPublications(projectId))[0]?.fired_at).toBeNull()
  })
})
