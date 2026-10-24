import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

/**
 * The setup wizard's routes through the real handlers: who approves what a click asks for (the clicker, with their
 * role), what goes on the setup record (054), and the Move click recorded on the import job.
 */

const mocks = vi.hoisted(() => ({
  bindMigrateGrantSite: vi.fn(),
  mergeOnClick: vi.fn(),
  liveSiteShowsCheck: vi.fn(),
  startMigrationMediaImport: vi.fn(),
  recordMediaApplyOutcome: vi.fn(),
  applyClickedMigrationMedia: vi.fn(),
}))
vi.mock('../../server/utils/migrate-site-binding-run', () => ({ bindMigrateGrantSite: mocks.bindMigrateGrantSite }))
vi.mock('../../server/utils/workspace-billing', () => ({ resolveWorkspaceBilling: async () => ({ effectivePlan: 'pro' }) }))
vi.mock('../../server/utils/click-approval', () => ({ mergeOnClick: mocks.mergeOnClick }))
vi.mock('../../server/utils/brain-cache', () => ({ getOrBuildBrainCache: async () => ({ config: { workflow: 'review' } }), invalidateBrainCache: () => {} }))
vi.mock('../../server/utils/content-engine', () => ({ createContentEngine: () => ({ mergeBranch: vi.fn() }) }))
vi.mock('../../server/utils/migration-live-check', async importOriginal => ({
  ...await importOriginal<object>(),
  liveSiteShowsCheck: mocks.liveSiteShowsCheck,
}))
vi.mock('../../server/utils/migrate-grant', () => ({ migrationSignedOrigin: async () => null }))
vi.mock('../../server/utils/migration-media-import', () => ({
  startMigrationMediaImport: mocks.startMigrationMediaImport,
  toMigrationMediaJobView: (job: { id: string, status: string }) => ({ id: job.id, status: job.status }),
  recordMediaApplyOutcome: mocks.recordMediaApplyOutcome,
  applyClickedMigrationMedia: mocks.applyClickedMigrationMedia,
}))

const BASE = '/api/workspaces/workspace-1/projects/project-1/migration'
const GRANT = { id: 'grant-1', kind: 'bundle', plan: 'pro', redeemed_at: '2026-10-01', revoked_at: null, user_id: 'user-0', email: 'buyer@acme.dev', site_binding_state: 'pr_open', site_binding_detail: { branch: 'cr/studio/binding/1', review: true }, media_state: null, media_detail: null }

let db: Record<string, ReturnType<typeof vi.fn>>
let setup: Record<string, unknown>
let isMerged: ReturnType<typeof vi.fn>

function stub(over: { role?: string, project?: Record<string, unknown>, grant?: Record<string, unknown> | null, job?: Record<string, unknown> | null } = {}) {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => (key === 'workspaceId' ? 'workspace-1' : key === 'projectId' ? 'project-1' : undefined)))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'admin-2', email: 'admin@acme.dev' }, accessToken: 't' }))
  vi.stubGlobal('checkRateLimit', vi.fn().mockResolvedValue({ allowed: true }))
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  vi.stubGlobal('getUpgradeParams', (plan: string) => ({ plan }))
  vi.stubGlobal('useMediaProvider', () => ({}))
  isMerged = vi.fn(async () => false)
  vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({ git: { isMerged, deleteBranch: vi.fn() }, contentRoot: '', project: { default_branch: 'main' } }))
  const project = { id: 'project-1', repo_full_name: 'Acme/Site', default_branch: 'main', migration_setup: setup, live_site_url: null, ...over.project }
  db = {
    requireWorkspaceRole: vi.fn().mockResolvedValue(over.role ?? 'admin'),
    getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'workspace-1', slug: 'acme', plan: 'pro', github_installation_id: 42 }),
    getWorkspaceById: vi.fn().mockResolvedValue({ plan: 'pro', media_storage_bytes: 0 }),
    getProjectForWorkspace: vi.fn(async () => project),
    getProjectById: vi.fn(async () => project),
    getMigrateGrantForProject: vi.fn().mockResolvedValue(over.grant === undefined ? GRANT : over.grant),
    getLatestMigrationMediaJob: vi.fn().mockResolvedValue(over.job === undefined ? { id: 'job-1', status: 'done' } : over.job),
    getMigrateCommentsExport: vi.fn().mockResolvedValue(null),
    updateProject: vi.fn(async () => ({})),
    mergeProjectMigrationSetup: vi.fn(async (_p: string, patch: Record<string, unknown>) => Object.assign(setup, patch)),
    setMigrationMediaJobApplyApprover: vi.fn().mockResolvedValue(true),
    getMigrationMediaJob: vi.fn(),
  }
  vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db))
}

async function post(path: string, route: string, body: Record<string, unknown> = {}, method = 'POST'): Promise<{ status: number, body: Record<string, unknown> }> {
  const handler = (await import(`../../server/api/workspaces/[workspaceId]/projects/[projectId]/migration/${route}`)).default
  let out!: { status: number, body: Record<string, unknown> }
  await withTestServer({ routes: [{ path: `${BASE}${path}`, method, handler }] as never }, async ({ request }) => {
    const res = await request(`${BASE}${path}`, method === 'GET' ? {} : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    out = { status: res.status, body: await res.json() as Record<string, unknown> }
  })
  return out
}

beforeEach(() => {
  setup = {}
  for (const fn of Object.values(mocks)) fn.mockReset()
})

describe('migration setup routes', () => {
  it('site binding again: the clicker approves it, with their role; a grant not in use is refused', async () => {
    stub()
    mocks.bindMigrateGrantSite.mockResolvedValue({ state: 'written' })
    expect(await post('/site-binding', 'site-binding.post')).toEqual({ status: 200, body: { siteBinding: { state: 'written' } } })
    expect(mocks.bindMigrateGrantSite).toHaveBeenCalledWith(expect.objectContaining({
      grant: GRANT,
      projectId: 'project-1',
      repo: { owner: 'Acme', name: 'Site' },
      plan: 'pro',
      approver: { id: 'admin-2', email: 'admin@acme.dev', workspaceId: 'workspace-1', role: 'admin' },
    }))

    stub({ grant: { ...GRANT, revoked_at: '2026-10-02' } })
    expect((await post('/site-binding', 'site-binding.post')).status).toBe(409)
    expect(mocks.bindMigrateGrantSite).toHaveBeenCalledTimes(1)
  })

  it('skip and take up a step; the live site address is https only; "I see it" only once the check is on its way', async () => {
    stub()
    await post('/setup', 'setup.post', { skip: 'images' })
    expect(db.mergeProjectMigrationSetup).toHaveBeenLastCalledWith('project-1', { skip_images: true })
    await post('/setup', 'setup.post', { unskip: 'images' })
    expect(db.mergeProjectMigrationSetup).toHaveBeenLastCalledWith('project-1', { skip_images: false })
    expect((await post('/setup', 'setup.post', { skip: 'everything' })).status).toBe(400)

    expect((await post('/setup', 'setup.post', { liveSiteUrl: 'http://acme.dev' })).status).toBe(400)
    expect(await post('/setup', 'setup.post', { liveSiteUrl: ' https://acme.dev ' })).toEqual({ status: 200, body: { liveSiteUrl: 'https://acme.dev' } })
    expect(db.updateProject).toHaveBeenCalledWith('project-1', { live_site_url: 'https://acme.dev' }, 'id')

    expect((await post('/setup', 'setup.post', { seen: true })).status).toBe(409)
    setup.live_check = { nonce: 'n1', status: 'pending_review', branch: 'cr/studio/live-check/1', at: 't' }
    expect((await post('/setup', 'setup.post', { seen: true })).status).toBe(409)
    setup.live_check = { nonce: 'n1', status: 'merged', at: 't' }
    expect((await post('/setup', 'setup.post', { seen: true })).status).toBe(200)
    expect(setup.live_check).toMatchObject({ nonce: 'n1', seenBy: 'owner', seenAt: expect.any(String) })
  })

  it('verify: seen on the live site marks the step; not there yet is an answer, not an error', async () => {
    setup = { live_check: { nonce: 'n1', status: 'merged', at: 't' } }
    stub({ project: { live_site_url: 'https://acme.dev' } })
    mocks.liveSiteShowsCheck.mockResolvedValueOnce(false)
    expect(await post('/live-check/verify', 'live-check/verify.post')).toEqual({ status: 200, body: { seen: false } })
    expect(db.mergeProjectMigrationSetup).not.toHaveBeenCalled()
    mocks.liveSiteShowsCheck.mockResolvedValueOnce(true)
    expect((await post('/live-check/verify', 'live-check/verify.post')).body).toMatchObject({ seen: true })
    expect(mocks.liveSiteShowsCheck).toHaveBeenCalledWith('https://acme.dev', 'n1')
    expect(setup.live_check).toMatchObject({ seenBy: 'fetch' })
  })

  it('approve the held media move: the owner\'s held branch merged under the clicker; the outcome on the setup', async () => {
    setup = { media_apply: { jobId: 'job-1', status: 'pending_review', branch: 'cr/media/migration/1', at: 't' } }
    stub()
    mocks.mergeOnClick.mockResolvedValue({ held: false, merge: { merged: true, sha: 'm', pullRequestUrl: null } })
    expect(await post('/media/approve', 'media/approve.post')).toEqual({ status: 200, body: { status: 'merged', branch: 'cr/media/migration/1', pullRequestUrl: null } })
    expect(mocks.mergeOnClick).toHaveBeenCalledWith(expect.objectContaining({ branch: 'cr/media/migration/1', plan: 'pro', approver: { id: 'admin-2', email: 'admin@acme.dev', role: 'admin', workspaceId: 'workspace-1' }, note: 'move this site\'s media to Studio' }))
    expect(setup.media_apply).toMatchObject({ jobId: 'job-1', status: 'merged' })
  })

  it('approve: the grant\'s held branch too; nothing held (or already merged) is a 404, and nothing is merged', async () => {
    stub({ grant: { ...GRANT, media_state: 'review', media_detail: { jobId: 'job-1', branch: 'cr/media/migration/2' } } })
    mocks.mergeOnClick.mockResolvedValue({ held: true })
    expect((await post('/media/approve', 'media/approve.post')).body).toEqual({ status: 'pending_review', branch: 'cr/media/migration/2', pullRequestUrl: null })

    mocks.mergeOnClick.mockClear()
    setup = {}
    stub({ grant: { ...GRANT, media_state: 'review', media_detail: { jobId: 'job-1', branch: 'cr/media/migration/2' } } })
    isMerged.mockResolvedValue(true)
    expect((await post('/media/approve', 'media/approve.post')).status).toBe(404)
    // Only a media branch is ever merged from here.
    stub({ grant: { ...GRANT, media_state: 'review', media_detail: { jobId: 'job-1', branch: 'main' } } })
    expect((await post('/media/approve', 'media/approve.post')).status).toBe(404)
    expect(mocks.mergeOnClick).not.toHaveBeenCalled()
  })

  it('Move: the clicker is recorded on the job; a job that closed first is applied at once under the click', async () => {
    stub({ role: 'owner' })
    mocks.startMigrationMediaImport.mockResolvedValue({ job: { id: 'job-1', status: 'queued' }, created: true, skipped: {} })
    const approver = { id: 'admin-2', email: 'admin@acme.dev', role: 'owner', workspaceId: 'workspace-1', deleteLocal: true }
    expect((await post('/media', 'media.post', { applyWhenDone: true, deleteLocal: true })).body).not.toHaveProperty('applied')
    expect(db.setMigrationMediaJobApplyApprover).toHaveBeenCalledWith('project-1', 'job-1', approver)
    expect(mocks.recordMediaApplyOutcome).not.toHaveBeenCalled()

    // Done before the click was recorded (nothing left to fetch): applied here.
    db.setMigrationMediaJobApplyApprover.mockResolvedValue(false)
    db.getMigrationMediaJob.mockResolvedValue({ id: 'job-1', status: 'done', migrate_grant_id: null })
    mocks.recordMediaApplyOutcome.mockImplementation(async (_p: string, _j: string, run: () => Promise<unknown>) => run())
    mocks.applyClickedMigrationMedia.mockResolvedValue({ status: 'merged' })
    expect((await post('/media', 'media.post', { applyWhenDone: true, deleteLocal: true })).body).toMatchObject({ applied: { status: 'merged' } })
    expect(mocks.applyClickedMigrationMedia).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), 'pro', approver)

    // Without the flag (the card's start): nothing recorded, nothing applied.
    db.setMigrationMediaJobApplyApprover.mockClear()
    await post('/media', 'media.post', {})
    expect(db.setMigrationMediaJobApplyApprover).not.toHaveBeenCalled()
  })

  it('comments preview: up to two approved top-level comments from the held export, never a fetch', async () => {
    stub()
    db.getMigrateCommentsExport.mockResolvedValue({
      grantId: 'grant-1',
      status: 'ready',
      comments: 4,
      payload: { comments: [
        { id: 1, post: 9, parent: null, author: 'Ada', content: '<p>Great   post, thanks!</p>', approved: '1' },
        { id: 2, post: 9, parent: 1, author: 'Bob', content: 'reply', approved: '1' },
        { id: 3, post: 9, parent: null, author: 'Spam', content: 'buy', approved: '0' },
        { id: 4, post: 9, parent: null, author: 'Cy', content: 'x'.repeat(300) },
      ] },
    })
    const { body } = await post('/comments-preview', 'comments-preview.get', {}, 'GET')
    expect(body).toEqual({ total: 4, rows: [{ author: 'Ada', excerpt: 'Great post, thanks!' }, { author: 'Cy', excerpt: `${'x'.repeat(139)}…` }] })
    expect(db.getMigrateCommentsExport).toHaveBeenCalledWith('workspace-1', 'Acme/Site', { withPayload: true })

    db.getMigrateCommentsExport.mockResolvedValue({ grantId: 'grant-1', status: 'imported', comments: 4 })
    expect((await post('/comments-preview', 'comments-preview.get', {}, 'GET')).body).toEqual({ total: 4, rows: [] })
  })
})
