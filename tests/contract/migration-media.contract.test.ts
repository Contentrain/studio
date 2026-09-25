import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationMediaMethods } from '../../server/providers/postgres-db/migration-media'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

/**
 * Migration 037 on a real Postgres: one open job per project, the claim lease,
 * settle only by the claim holder and only a pending item, counters moving
 * with each settle, pause/resume, and a crashed holder's lease taken over.
 */
describe('postgres-db migration media jobs (contract)', () => {
  const db = migrationMediaMethods()
  let user: SeededUser
  let projectId: string
  const t0 = new Date('2040-01-01T00:00:00Z')
  const item = (repoPath: string, bytes = 100) => ({ repoPath, blobSha: `sha-${repoPath}`, bytes, mime: 'image/png' })

  beforeAll(async () => {
    user = await seedUser('migration-media')
    const result = await sql<{ id: string }>`INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/migration-media') RETURNING id`.execute(getDb())
    projectId = result.rows[0]!.id
  })
  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('runs a job through claim → settle → pause → resume → take-over → done', async () => {
    const start = () => db.createMigrationMediaJob({
      projectId,
      workspaceId: user.workspaceId,
      createdBy: user.userId,
      manifestRef: 'contentrain',
      manifestCommit: 'c0ffee',
      items: [item('public/media/a.png', 100), item('public/media/b.png', 200), item('public/media/c.png', 300)],
    })
    const first = await start()
    expect(first.created).toBe(true)
    expect(first.job).toMatchObject({ status: 'queued', total: 3, done: 0 })
    const jobId = String(first.job.id)

    // One open job per project.
    const again = await start()
    expect(again).toMatchObject({ created: false, job: { id: jobId } })

    const claim = (await db.claimMigrationMediaJob(t0, 300))!
    expect(claim).toMatchObject({ id: jobId, status: 'running' })
    const token = String(claim.claim_token)
    expect(await db.claimMigrationMediaJob(new Date(t0.getTime() + 60_000), 300)).toBeNull()

    expect(await db.settleMigrationMediaItem({ jobId, token, repoPath: 'public/media/a.png', ok: true, assetId: null, deliveryUrl: 'https://studio.test/a.png' }, t0)).toBe(true)
    // A settled item cannot be settled again, and another token settles nothing.
    expect(await db.settleMigrationMediaItem({ jobId, token, repoPath: 'public/media/a.png', ok: false }, t0)).toBe(false)
    expect(await db.settleMigrationMediaItem({ jobId, token: '00000000-0000-0000-0000-000000000000', repoPath: 'public/media/b.png', ok: true }, t0)).toBe(false)

    expect(await db.finishMigrationMediaJob(jobId, token, 'paused_quota', 'storage.quota_exceeded', t0)).toBe(true)
    const paused = await db.getMigrationMediaJob(projectId, jobId)
    expect(paused).toMatchObject({ status: 'paused_quota', done: 1, claim_token: null })
    expect(Number(paused?.bytes_done)).toBe(100)
    // Paused: not claimable until resumed; resume only works on a paused job.
    expect(await db.claimMigrationMediaJob(new Date(t0.getTime() + 600_000), 300)).toBeNull()
    expect(await db.resumeMigrationMediaJob(projectId, jobId)).toMatchObject({ status: 'queued' })
    expect(await db.resumeMigrationMediaJob(projectId, jobId)).toBeNull()

    const stale = (await db.claimMigrationMediaJob(t0, 300))!
    const takeover = (await db.claimMigrationMediaJob(new Date(t0.getTime() + 301_000), 300))!
    expect(takeover.claim_token).not.toBe(stale.claim_token)
    expect(await db.settleMigrationMediaItem({ jobId, token: String(stale.claim_token), repoPath: 'public/media/b.png', ok: true }, t0)).toBe(false)
    const token2 = String(takeover.claim_token)
    expect(await db.settleMigrationMediaItem({ jobId, token: token2, repoPath: 'public/media/b.png', ok: true, deduped: true }, t0)).toBe(true)
    expect(await db.settleMigrationMediaItem({ jobId, token: token2, repoPath: 'public/media/c.png', ok: false, error: 'media.svg_unsafe', statusCode: 400 }, t0)).toBe(true)
    expect(await db.listPendingMigrationMediaItems(jobId, 10)).toEqual([])
    expect(await db.finishMigrationMediaJob(jobId, token2, 'done', null, t0)).toBe(true)

    const done = await db.getMigrationMediaJob(projectId, jobId)
    expect(done).toMatchObject({ status: 'done', done: 2, failed: 1, deduped: 1 })
    expect(Number(done?.bytes_done)).toBe(100)
    expect(done?.finished_at).toBeTruthy()
    expect((await db.listMigrationMediaItems(jobId, 'failed', 10)).map(r => [r.repo_path, r.error, r.status_code])).toEqual([['public/media/c.png', 'media.svg_unsafe', 400]])
    expect(await db.getLatestMigrationMediaJob(projectId)).toMatchObject({ id: jobId })

    // Finished: a new start opens a new job.
    expect((await start()).created).toBe(true)
  })
})
