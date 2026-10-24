import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A bundle grant's site binding starts the project's media import for that grant, whatever the binding's state: the
 * media move does not wait on studio.json. Only the first time: from then on the media sweep moves it on
 * (`migrate-grant-media.test.ts`). The import itself (`startMigrationMediaImport`) and the binding's write
 * (`ensureMigrateSiteBinding`) are covered on their own; here, what the binding hands the import and when.
 */
const ensureMigrateSiteBinding = vi.fn()
vi.mock('../../server/utils/migrate-site-binding', () => ({
  ensureMigrateSiteBinding: (...a: unknown[]) => ensureMigrateSiteBinding(...a),
  SITE_BINDING_ALARM_ATTEMPTS: 3,
  SITE_BINDING_MAX_ATTEMPTS: 5,
}))
const startMigrationMediaImport = vi.fn()
const applyGrantMigrationMedia = vi.fn()
vi.mock('../../server/utils/migration-media-import', () => ({
  startMigrationMediaImport: (...a: unknown[]) => startMigrationMediaImport(...a),
  applyGrantMigrationMedia: (...a: unknown[]) => applyGrantMigrationMedia(...a),
}))
vi.mock('../../server/utils/migrate-grant', () => ({ migrationSignedOrigin: async () => 'https://old.example.com' }))
vi.mock('../../server/utils/providers', () => ({ useGitProvider: () => ({ getDefaultBranch: async () => 'main', listBranches: async () => [], isMerged: async () => false }) }))
vi.mock('../../server/utils/media-url', () => ({ publicMediaBase: (id: string) => `https://studio.test/api/cdn/v1/${id}` }))
vi.mock('../../server/utils/license', () => ({ hasFeature: (plan: string, feature: string) => feature === 'media.upload' && plan !== 'free', getPlanLimit: () => 1 }))
vi.mock('../../server/utils/migration-media-write', () => ({ migrationMediaLanded: async () => false }))

const grant: Record<string, unknown> = { id: 'grant-1', user_id: 'user-1', site_binding_attempts: 0 }
const workspace = { id: 'ws-1', type: 'primary', plan: 'pro', overage_settings: null, github_installation_id: 42, media_storage_bytes: 1024 }
const db = {
  setMigrateGrantSiteBinding: vi.fn(),
  getProjectById: vi.fn(async () => ({ id: 'p-1', content_root: '', default_branch: 'main' })),
  getActivePaymentAccount: vi.fn(),
  getLatestMigrationMediaJob: vi.fn(async (_projectId: string): Promise<Record<string, unknown> | null> => null),
  setMigrateGrantMedia: vi.fn(),
}

async function bind(plan = 'pro', g = grant) {
  const { bindMigrateGrantSite } = await import('../../server/utils/migrate-site-binding-run')
  return bindMigrateGrantSite({ db: db as never, grant: g, workspace, projectId: 'p-1', repo: { owner: 'acme', name: 'site' }, plan })
}
const skipped = { overSize: [], missing: [], fontsKept: [], onOrigin: { overSize: [], offOrigin: 0, unverified: 0 } }

describe('a bundle grant\'s binding starts its media import', () => {
  beforeEach(() => {
    ensureMigrateSiteBinding.mockReset()
    startMigrationMediaImport.mockReset().mockResolvedValue({ job: { id: 'job-1', status: 'queued', total: 3 }, created: true, skipped })
    applyGrantMigrationMedia.mockReset()
    db.getLatestMigrationMediaJob.mockReset().mockResolvedValue(null)
    db.setMigrateGrantMedia.mockReset()
    vi.stubGlobal('useMediaProvider', () => ({}))
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.test' } }))
  })

  it.each(['written', 'partial'])('a %s binding starts the import for the grant, with its signed origin', async (state) => {
    ensureMigrateSiteBinding.mockResolvedValue({ state })
    expect(await bind()).toEqual({ state })
    expect(startMigrationMediaImport).toHaveBeenCalledTimes(1)
    expect(startMigrationMediaImport).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      plan: 'pro',
      usedBytes: 1024,
      defaultBranch: 'main',
      signedOrigin: 'https://old.example.com',
      migrateGrantId: 'grant-1',
    }))
    expect(applyGrantMigrationMedia).not.toHaveBeenCalled()
  })

  it.each(['importing', 'paused_quota', 'failed', 'pending', 'review', 'connected', 'none'])('a grant whose media is already %s: a pass over its binding leaves the media to the media sweep', async (mediaState) => {
    ensureMigrateSiteBinding.mockResolvedValue({ state: 'pr_open', prUrl: 'https://github.com/acme/site/pull/1' })
    await bind('pro', { ...grant, media_state: mediaState })
    expect(db.getLatestMigrationMediaJob).not.toHaveBeenCalled()
    expect(startMigrationMediaImport).not.toHaveBeenCalled()
    expect(applyGrantMigrationMedia).not.toHaveBeenCalled()
  })

  it.each(['queued', 'running', 'done', 'canceled'])('a project with a %s import job already: the first pass starts nothing new', async (status) => {
    ensureMigrateSiteBinding.mockResolvedValue({ state: 'written' })
    db.getLatestMigrationMediaJob.mockResolvedValue({ id: 'job-1', status, migrate_grant_id: null })
    await bind()
    expect(db.getLatestMigrationMediaJob).toHaveBeenCalledWith('p-1')
    expect(startMigrationMediaImport).not.toHaveBeenCalled()
    expect(applyGrantMigrationMedia).not.toHaveBeenCalled()
  })

  it('a job with nothing to fetch is applied at once', async () => {
    ensureMigrateSiteBinding.mockResolvedValue({ state: 'written' })
    const empty = { id: 'job-2', status: 'done', total: 2, migrate_grant_id: 'grant-1' }
    startMigrationMediaImport.mockResolvedValue({ job: empty, created: true, skipped })
    applyGrantMigrationMedia.mockResolvedValue({ status: 'merged', pullRequestUrl: null })
    await bind()
    expect(applyGrantMigrationMedia).toHaveBeenCalledWith(empty, 'pro')
    expect(db.setMigrateGrantMedia).toHaveBeenCalledWith('grant-1', expect.objectContaining({ state: 'connected', detail: expect.objectContaining({ appliedJobId: 'job-2' }) }))
  })

  it.each(['conflict', 'failed', 'pr_open'])('a %s binding does not hold the import back', async (state) => {
    ensureMigrateSiteBinding.mockResolvedValue({ state })
    expect(await bind()).toEqual({ state })
    expect(startMigrationMediaImport).toHaveBeenCalledTimes(1)
    expect(startMigrationMediaImport).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-1', migrateGrantId: 'grant-1' }))
  })

  it('without a media stack or the plan\'s media upload nothing starts; an import that fails leaves the binding as it is', async () => {
    ensureMigrateSiteBinding.mockResolvedValue({ state: 'written' })
    vi.stubGlobal('useMediaProvider', () => null)
    await bind()
    vi.stubGlobal('useMediaProvider', () => ({}))
    await bind('free')
    expect(startMigrationMediaImport).not.toHaveBeenCalled()

    vi.spyOn(console, 'error').mockImplementation(() => {})
    startMigrationMediaImport.mockRejectedValue(Object.assign(new Error('github down'), { statusCode: 502 }))
    expect(await bind()).toEqual({ state: 'written' })
    expect(db.setMigrateGrantMedia).toHaveBeenCalledWith('grant-1', expect.objectContaining({ state: 'failed', attempts: 1 }))
  })
})
