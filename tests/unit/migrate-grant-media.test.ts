import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Where a bundle grant's media move stands and what moves it on (053): read from the project's latest import job,
 * whoever started it. The import, the apply and the landed check are covered on their own; here, the decision.
 */
const startMigrationMediaImport = vi.fn()
const applyGrantMigrationMedia = vi.fn()
vi.mock('../../server/utils/migration-media-import', () => ({
  startMigrationMediaImport: (...a: unknown[]) => startMigrationMediaImport(...a),
  applyGrantMigrationMedia: (...a: unknown[]) => applyGrantMigrationMedia(...a),
}))
const migrationMediaLanded = vi.fn()
vi.mock('../../server/utils/migration-media-write', () => ({ migrationMediaLanded: (...a: unknown[]) => migrationMediaLanded(...a) }))
const alarms: unknown[] = []
vi.mock('../../server/utils/alert', () => ({ reportMigrateGrantMediaAlarm: (c: unknown) => alarms.push(c) }))
vi.mock('../../server/utils/migrate-grant', () => ({ migrationSignedOrigin: async () => 'https://old.example.com' }))
vi.mock('../../server/utils/providers', () => ({ useGitProvider: () => git }))
vi.mock('../../server/utils/license', () => ({
  hasFeature: (plan: string, feature: string) => feature === 'media.upload' && plan !== 'free',
  getPlanLimit: () => 1,
}))
vi.mock('../../server/utils/overage', () => ({ getEffectiveLimit: (base: number) => base }))

const GB = 1024 * 1024 * 1024
const NOW = new Date('2026-10-24T12:00:00.000Z')
const git = {
  listBranches: vi.fn(async (): Promise<Array<{ name: string }>> => []),
  isMerged: vi.fn(async () => false),
  getDefaultBranch: async () => 'main',
}
const db = {
  getLatestMigrationMediaJob: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  listPendingMigrationMediaItems: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  listMigrationMediaItems: vi.fn(async () => []),
  resumeMigrationMediaJob: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  setMigrateGrantMedia: vi.fn(),
  markMigrateGrantMediaAlerted: vi.fn(async () => true),
  getActivePaymentAccount: vi.fn(),
}

function grant(extra: Record<string, unknown> = {}) {
  return { id: 'grant-1', user_id: 'user-1', ...extra }
}

async function advance(g = grant(), opts: { usedBytes?: number, plan?: string, mediaStack?: boolean } = {}) {
  const { advanceGrantMedia } = await import('../../server/utils/migrate-grant-media')
  return advanceGrantMedia({
    db: db as never,
    grant: g,
    workspace: { id: 'ws-1', overage_settings: null, media_storage_bytes: opts.usedBytes ?? 0 },
    projectId: 'p-1',
    repo: { owner: 'acme', name: 'site' },
    git: git as never,
    contentRoot: '',
    defaultBranch: 'main',
    plan: opts.plan ?? 'pro',
    mediaStack: opts.mediaStack ?? true,
    now: () => NOW,
  })
}

const recorded = () => db.setMigrateGrantMedia.mock.calls.map(c => c[1] as { state: string, detail: Record<string, unknown>, attempts?: number, nextAt?: Date | null })
const skipped = (overSize = 0, reasons: string[] = []) => ({ overSize: Array.from({ length: overSize }, () => ({})), missing: [], fontsKept: [], onOrigin: { overSize: reasons.map(reason => ({ reason })), offOrigin: 0, unverified: 0 } })

describe('a bundle grant\'s media move', () => {
  beforeEach(() => {
    for (const fn of [startMigrationMediaImport, applyGrantMigrationMedia, migrationMediaLanded, git.listBranches, git.isMerged, ...Object.values(db)]) fn.mockReset()
    db.getLatestMigrationMediaJob.mockResolvedValue(null)
    db.listPendingMigrationMediaItems.mockResolvedValue([])
    db.markMigrateGrantMediaAlerted.mockResolvedValue(true)
    git.listBranches.mockResolvedValue([])
    git.isMerged.mockResolvedValue(false)
    migrationMediaLanded.mockResolvedValue(false)
    alarms.length = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('no job yet: starts one for the grant and records it importing, with the old-site files it refused as too large that Migrate did not', async () => {
    startMigrationMediaImport.mockResolvedValue({ job: { id: 'job-1', status: 'queued', total: 4 }, created: true, skipped: skipped(2, ['count-cap', 'file-too-large', 'total-cap']) })
    expect(await advance()).toEqual({ state: 'importing', acted: true })
    expect(startMigrationMediaImport).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-1', migrateGrantId: 'grant-1', signedOrigin: 'https://old.example.com' }))
    expect(recorded()).toEqual([expect.objectContaining({ state: 'importing', detail: expect.objectContaining({ jobId: 'job-1', startedBy: 'grant', refusedTooLarge: 2 }), attempts: 0 })])
  })

  it('no manifest, or nothing Studio takes: none, and never started again', async () => {
    startMigrationMediaImport.mockRejectedValueOnce(Object.assign(new Error('migration.media_manifest_missing'), { statusCode: 404 }))
    expect((await advance()).state).toBe('none')
    startMigrationMediaImport.mockResolvedValueOnce({ job: { id: 'job-2', status: 'done', total: 0 }, created: true, skipped: skipped(0, ['count-cap', 'count-cap', 'total-cap']) })
    expect((await advance()).state).toBe('none')
    expect(recorded().map(r => [r.state, r.detail.code, r.detail.refusedTooLarge])).toEqual([['none', 'manifest_missing', undefined], ['none', 'nothing_to_move', 3]])
    expect(applyGrantMigrationMedia).not.toHaveBeenCalled()
  })

  it('a failed start is tried again with backoff, the alarm goes out once at the third, and a capped one waits', async () => {
    startMigrationMediaImport.mockRejectedValue(Object.assign(new Error('github down'), { statusCode: 502 }))
    expect((await advance()).state).toBe('failed')
    expect(recorded()[0]).toMatchObject({ state: 'failed', detail: { code: 'start_failed' }, attempts: 1, nextAt: new Date(NOW.getTime() + 30 * 60 * 1000) })

    // Not due yet: nothing is tried.
    await advance(grant({ media_state: 'failed', media_attempts: 1, media_next_at: new Date(NOW.getTime() + 60_000).toISOString() }))
    expect(startMigrationMediaImport).toHaveBeenCalledTimes(1)

    await advance(grant({ media_state: 'failed', media_attempts: 2, media_next_at: NOW.toISOString() }))
    expect(alarms).toEqual([expect.objectContaining({ grantId: 'grant-1', code: 'start_failed', attempts: 3 })])
    await advance(grant({ media_state: 'failed', media_attempts: 3, media_next_at: NOW.toISOString(), media_alerted_at: NOW.toISOString() }))
    expect(alarms).toHaveLength(1)

    startMigrationMediaImport.mockClear()
    await advance(grant({ media_state: 'failed', media_attempts: 5, media_next_at: null }))
    expect(startMigrationMediaImport).not.toHaveBeenCalled()
  })

  it('an open job is importing; nothing new starts', async () => {
    db.getLatestMigrationMediaJob.mockResolvedValue({ id: 'job-1', status: 'running', migrate_grant_id: 'grant-1' })
    expect(await advance()).toEqual({ state: 'importing', acted: false })
    expect(startMigrationMediaImport).not.toHaveBeenCalled()
  })

  it('a job paused for storage resumes once the workspace has room for its next file, and waits otherwise', async () => {
    db.getLatestMigrationMediaJob.mockResolvedValue({ id: 'job-1', status: 'paused_quota', migrate_grant_id: 'grant-1' })
    db.listPendingMigrationMediaItems.mockResolvedValue([{ repo_path: 'public/media/a.jpg', bytes: 100 }])
    expect(await advance(grant(), { usedBytes: GB - 50 })).toEqual({ state: 'paused_quota', acted: false })
    expect(db.resumeMigrationMediaJob).not.toHaveBeenCalled()

    db.resumeMigrationMediaJob.mockResolvedValue({ id: 'job-1', status: 'queued' })
    expect(await advance(grant(), { usedBytes: GB - 100 })).toEqual({ state: 'importing', acted: true })
    expect(db.resumeMigrationMediaJob).toHaveBeenCalledWith('p-1', 'job-1')
  })

  it('a grant\'s failed job is started again under the retry rule; an owner\'s failed or any canceled job is the owner\'s', async () => {
    startMigrationMediaImport.mockResolvedValue({ job: { id: 'job-2', status: 'queued', total: 1 }, created: true, skipped: skipped() })
    db.getLatestMigrationMediaJob.mockResolvedValue({ id: 'job-1', status: 'failed', migrate_grant_id: 'grant-1' })
    expect((await advance()).state).toBe('importing')
    expect(recorded()[0]?.detail).toMatchObject({ previousJobId: 'job-1', jobId: 'job-2' })

    startMigrationMediaImport.mockClear()
    for (const job of [{ id: 'job-3', status: 'failed', migrate_grant_id: null }, { id: 'job-4', status: 'canceled', migrate_grant_id: 'grant-1' }]) {
      db.getLatestMigrationMediaJob.mockResolvedValue(job)
      expect((await advance()).state).toBe('pending')
    }
    expect(startMigrationMediaImport).not.toHaveBeenCalled()
    expect(recorded().slice(1).map(r => r.detail.code)).toEqual(['job_failed', 'canceled'])
  })

  it('a done job whose addresses are on the default branch is connected, whoever started it', async () => {
    db.getLatestMigrationMediaJob.mockResolvedValue({ id: 'job-1', status: 'done', migrate_grant_id: null })
    migrationMediaLanded.mockResolvedValue(true)
    expect(await advance()).toEqual({ state: 'connected', acted: false })
    expect(migrationMediaLanded).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-1', defaultBranch: 'main' }))
  })

  it('a done job not landed: review while a cr/media branch is open (a merged one holds nothing), else pending for an owner\'s job', async () => {
    db.getLatestMigrationMediaJob.mockResolvedValue({ id: 'job-1', status: 'done', migrate_grant_id: null })
    git.listBranches.mockResolvedValue([{ name: 'cr/media/old' }, { name: 'cr/media/new' }])
    git.isMerged.mockImplementation(async (name: string) => name === 'cr/media/old')
    expect((await advance()).state).toBe('review')
    expect(recorded()[0]?.detail).toMatchObject({ branch: 'cr/media/new' })

    git.listBranches.mockResolvedValue([])
    expect((await advance()).state).toBe('pending')
    expect(applyGrantMigrationMedia).not.toHaveBeenCalled()
  })

  it('the grant\'s own done job, never applied: applied once and recorded; held for review it stays under review', async () => {
    const job = { id: 'job-1', status: 'done', migrate_grant_id: 'grant-1' }
    db.getLatestMigrationMediaJob.mockResolvedValue(job)
    applyGrantMigrationMedia.mockResolvedValue({ status: 'pending_review', branch: 'cr/media/x' })
    expect(await advance()).toEqual({ state: 'review', acted: true })
    expect(applyGrantMigrationMedia).toHaveBeenCalledWith(job, 'pro')
    expect(recorded()[0]).toMatchObject({ state: 'review', detail: { appliedJobId: 'job-1', branch: 'cr/media/x' } })

    // Rejected by its reviewer (the branch is gone, nothing landed): pending, never sent again.
    applyGrantMigrationMedia.mockClear()
    expect((await advance(grant({ media_state: 'review', media_detail: { jobId: 'job-1', appliedJobId: 'job-1' } }))).state).toBe('pending')
    expect(applyGrantMigrationMedia).not.toHaveBeenCalled()
  })

  it('an apply that opened a pull request into a protected default branch is review until it lands', async () => {
    db.getLatestMigrationMediaJob.mockResolvedValue({ id: 'job-1', status: 'done', migrate_grant_id: 'grant-1' })
    const detail = { jobId: 'job-1', appliedJobId: 'job-1', pullRequestUrl: 'https://github.com/acme/site/pull/9' }
    expect((await advance(grant({ media_state: 'review', media_detail: detail }))).state).toBe('review')
    migrationMediaLanded.mockResolvedValue(true)
    expect((await advance(grant({ media_state: 'review', media_detail: detail }))).state).toBe('connected')
    expect(applyGrantMigrationMedia).not.toHaveBeenCalled()
  })

  it('a refused apply is failed with backoff and not marked applied, so the sweep sends it again', async () => {
    db.getLatestMigrationMediaJob.mockResolvedValue({ id: 'job-1', status: 'done', migrate_grant_id: 'grant-1' })
    applyGrantMigrationMedia.mockRejectedValue(Object.assign(new Error('cdn off'), { statusCode: 409, data: { blocked: 'cdn_disabled' } }))
    expect((await advance()).state).toBe('failed')
    expect(recorded()[0]).toMatchObject({ state: 'failed', detail: { code: 'apply_cdn_disabled' }, attempts: 1 })
    expect(recorded()[0]?.detail).not.toHaveProperty('appliedJobId')
  })

  it('without a media stack or the plan\'s media upload nothing is looked at or recorded', async () => {
    expect(await advance(grant(), { mediaStack: false })).toEqual({ state: null, acted: false })
    expect(await advance(grant(), { plan: 'free' })).toEqual({ state: null, acted: false })
    expect(db.getLatestMigrationMediaJob).not.toHaveBeenCalled()
    expect(db.setMigrateGrantMedia).not.toHaveBeenCalled()
  })
})
