import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schedulingMethods } from '../../server/providers/postgres-db/scheduling'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db scheduling + deploy target (contract)', () => {
  const methods = schedulingMethods()
  let user: SeededUser
  let projectId: string

  beforeAll(async () => {
    user = await seedUser('scheduling')
    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/scheduling-fixture') RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('deploy target: set as jsonb object, read back, clear', async () => {
    await methods.setProjectDeployTarget(projectId, { provider: 'netlify', hook_url_encrypted: 'enc', hook_hint: 'h', triggers: { on_publish: true, on_schedule: true }, updated_at: 'x' })
    const row = await sql<{ deploy_target: Record<string, unknown> | null }>`SELECT deploy_target FROM public.projects WHERE id = ${projectId}`.execute(getDb())
    expect(row.rows[0]!.deploy_target).toMatchObject({ provider: 'netlify', hook_hint: 'h' })

    await methods.setProjectDeployTarget(projectId, null)
    const cleared = await sql<{ deploy_target: unknown }>`SELECT deploy_target FROM public.projects WHERE id = ${projectId}`.execute(getDb())
    expect(cleared.rows[0]!.deploy_target).toBeNull()
  })

  it('boundaries: upsert replaces per entry+kind, clear drops pending ones, claim is atomic and one-shot', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const row = (entry: string, kind: 'publish' | 'expire', fireAt: string) => ({
      project_id: projectId, workspace_id: user.workspaceId, model_id: 'posts', entry_id: entry, locale: 'en', kind, fire_at: fireAt,
    })

    await methods.upsertScheduledPublications([row('a', 'publish', future), row('b', 'publish', past), row('b', 'expire', future)])
    // Re-save of `a` moves its boundary (same row, new fire_at)
    const moved = new Date(Date.now() + 7_200_000).toISOString()
    await methods.upsertScheduledPublications([row('a', 'publish', moved)])

    const pending = await methods.listPendingScheduledPublications(projectId)
    // ordered by fire_at: b:publish (past) · b:expire (+1h) · a:publish (moved to +2h)
    expect(pending.map(p => `${p.entry_id}:${p.kind}`)).toEqual(['b:publish', 'b:expire', 'a:publish'])
    expect(new Date(pending.find(p => p.entry_id === 'a')!.fire_at as string).toISOString()).toBe(moved)

    // Clear only b's expire
    await methods.clearScheduledPublications(projectId, 'posts', ['b'], 'en', ['expire'])
    expect((await methods.listPendingScheduledPublications(projectId)).map(p => `${p.entry_id}:${p.kind}`)).toEqual(['b:publish', 'a:publish'])

    // Claim: only the due one, and only once
    const claimed = await methods.claimDueScheduledPublications(new Date(), 50)
    expect(claimed.map(c => `${c.entry_id}:${c.kind}`)).toEqual(['b:publish'])
    expect(claimed[0]!.fired_at).not.toBeNull()
    expect(await methods.claimDueScheduledPublications(new Date(), 50)).toEqual([])

    // A fired row is no longer pending, and clearing does not touch it
    expect((await methods.listPendingScheduledPublications(projectId)).map(p => p.entry_id)).toEqual(['a'])
    await methods.clearScheduledPublications(projectId, 'posts', ['b'])
    const fired = await sql<{ n: string }>`SELECT count(*)::text AS n FROM public.scheduled_publications WHERE project_id = ${projectId} AND entry_id = 'b'`.execute(getDb())
    expect(fired.rows[0]!.n).toBe('1')

    // Re-registering a fired boundary makes it pending again
    await methods.upsertScheduledPublications([row('b', 'publish', future)])
    expect((await methods.listPendingScheduledPublications(projectId)).map(p => p.entry_id).sort()).toEqual(['a', 'b'])
  })
})
