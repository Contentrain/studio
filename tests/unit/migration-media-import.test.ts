import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrationMediaTick, startMigrationMediaImport, toMigrationMediaJobView } from '../../server/utils/migration-media-import'

/**
 * The import job's lifecycle against an in-memory store with the semantics of
 * migration 037's functions (claim under a lease, settle only by the claim
 * holder and only a pending item, finish only by the claim holder). The real
 * SQL is covered by tests/contract/migration-media.contract.test.ts.
 */

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b00000000049454e44ae426082', 'hex')
const svg = (n: number) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 ${n}"/></svg>`)

interface Job { id: string, project_id: string, workspace_id: string, created_by: string, status: string, total: number, done: number, failed: number, deduped: number, bytes_done: number, error: string | null, claim_token: string | null, lease_until: number | null, created_at: string, finished_at: string | null }
interface Item { job_id: string, repo_path: string, blob_sha: string, bytes: number, mime: string, width: number | null, height: number | null, alt: string | null, state: string, asset_id: string | null, delivery_url: string | null, deduped: boolean, error: string | null, status_code: number | null }

function memoryStore() {
  const jobs: Job[] = []
  const items: Item[] = []
  let n = 0
  const open = (projectId: string) => jobs.find(j => j.project_id === projectId && ['queued', 'running', 'paused_quota'].includes(j.status))
  return {
    jobs,
    items,
    async createMigrationMediaJob(input: { projectId: string, workspaceId: string, createdBy: string, items: Array<{ repoPath: string, blobSha: string, bytes: number, mime: string, width?: number, height?: number, alt?: string }> }) {
      const existing = open(input.projectId)
      if (existing) return { job: existing, created: false }
      const job: Job = { id: `job-${++n}`, project_id: input.projectId, workspace_id: input.workspaceId, created_by: input.createdBy, status: input.items.length ? 'queued' : 'done', total: input.items.length, done: 0, failed: 0, deduped: 0, bytes_done: 0, error: null, claim_token: null, lease_until: null, created_at: new Date().toISOString(), finished_at: null }
      jobs.push(job)
      for (const i of input.items) items.push({ job_id: job.id, repo_path: i.repoPath, blob_sha: i.blobSha, bytes: i.bytes, mime: i.mime, width: i.width ?? null, height: i.height ?? null, alt: i.alt ?? null, state: 'pending', asset_id: null, delivery_url: null, deduped: false, error: null, status_code: null })
      return { job, created: true }
    },
    async claimMigrationMediaJob(now: Date, leaseSeconds: number) {
      const job = jobs.find(j => ['queued', 'running'].includes(j.status) && (j.lease_until === null || j.lease_until <= now.getTime()))
      if (!job) return null
      Object.assign(job, { status: 'running', claim_token: `tok-${++n}`, lease_until: now.getTime() + leaseSeconds * 1000 })
      return { ...job }
    },
    async listPendingMigrationMediaItems(jobId: string, limit: number) {
      return items.filter(i => i.job_id === jobId && i.state === 'pending').sort((a, b) => a.repo_path.localeCompare(b.repo_path)).slice(0, limit)
    },
    async settleMigrationMediaItem(input: { jobId: string, token: string, repoPath: string, ok: boolean, assetId?: string | null, deliveryUrl?: string | null, deduped?: boolean, error?: string | null, statusCode?: number | null }) {
      const job = jobs.find(j => j.id === input.jobId && j.claim_token === input.token)
      const item = items.find(i => i.job_id === input.jobId && i.repo_path === input.repoPath && i.state === 'pending')
      if (!job || !item) return false
      Object.assign(item, { state: input.ok ? 'done' : 'failed', asset_id: input.assetId ?? null, delivery_url: input.deliveryUrl ?? null, deduped: !!input.deduped, error: input.error ?? null, status_code: input.statusCode ?? null })
      if (input.ok) job.done++
      else job.failed++
      if (input.ok && input.deduped) job.deduped++
      if (input.ok && !input.deduped) job.bytes_done += item.bytes
      return true
    },
    async finishMigrationMediaJob(jobId: string, token: string, status: string, error: string | null) {
      const job = jobs.find(j => j.id === jobId && j.claim_token === token)
      if (!job) return false
      Object.assign(job, { status, error, claim_token: null, lease_until: null, finished_at: ['done', 'failed'].includes(status) ? 'now' : null })
      return true
    },
    async resumeMigrationMediaJob(projectId: string, jobId: string) {
      const job = jobs.find(j => j.id === jobId && j.project_id === projectId && j.status === 'paused_quota')
      if (!job) return null
      Object.assign(job, { status: 'queued', error: null })
      return job
    },
    getWorkspaceById: vi.fn(async () => ({ id: 'ws-1', overage_settings: null })),
    reserveStorageIfAllowed: vi.fn(async () => ({ allowed: true, currentBytes: 0 })),
    incrementWorkspaceStorageBytes: vi.fn(async () => undefined),
  }
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const asset = (repoPath: string, bytes: Buffer, mime: string, over: Record<string, unknown> = {}) => ({
  id: repoPath, role: 'media', repoPath, localUrl: `/${repoPath.replace(/^public\//, '')}`, sha256: sha(bytes), bytes: bytes.length, mime,
  refs: [{ file: 'content/blog/en.json', pointer: '/p1/cover', match: 'exact' }], ...over,
})

function fakeGit(files: Record<string, Buffer>, manifest: unknown) {
  const shaOf = (path: string) => `blob:${path}`
  return {
    readFile: vi.fn(async (path: string, ref: string) => {
      if (path === '.contentrain/migrate/media.json' && ref === 'contentrain') return JSON.stringify(manifest)
      throw new Error('not found')
    }),
    getTree: vi.fn(async () => Object.entries(files).map(([path, b]) => ({ path, type: 'blob' as const, sha: shaOf(path), size: b.length }))),
    getBranchSha: vi.fn(async () => 'c0ffee'),
    readBlob: vi.fn(async (blobSha: string) => {
      const path = blobSha.replace(/^blob:/, '')
      if (!files[path]) throw new Error('no such blob')
      return files[path]!
    }),
  }
}

let store: ReturnType<typeof memoryStore>
let uploads: number
const media = {
  upload: vi.fn(async (input: { filename: string, file: Buffer }) => ({ id: `as-${++uploads}`, originalPath: `media/original/${input.filename}`, size: input.file.length, filename: input.filename, contentType: 'image/png', variants: {} })),
}

beforeEach(() => {
  store = memoryStore()
  uploads = 0
  media.upload.mockClear()
  vi.stubGlobal('useDatabaseProvider', () => store)
  vi.stubGlobal('useMediaProvider', () => media)
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.test' } }))
  vi.stubGlobal('getPlanLimit', (_: string, key: string) => (key === 'media.storage_gb' ? 1 : key === 'media.max_file_size_mb' ? 5 : 5))
  vi.stubGlobal('getPlanLimitForPlan', (_: string, key: string) => (key === 'media.storage_gb' ? 15 : 50))
  vi.stubGlobal('getUpgradeParams', (from: string) => ({ plan: from }))
  vi.stubGlobal('hasFeature', (plan: string, feature: string) => feature === 'media.upload' && plan !== 'free')
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('errorMessage', (key: string) => key)
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), { statusCode: input.statusCode }))
})

const files = {
  'public/media/a.png': PNG,
  'public/media/b.svg': svg(1),
  'public/media/c.svg': svg(2),
}
const manifest = {
  version: 1,
  assets: [
    asset('public/media/a.png', PNG, 'image/png'),
    asset('public/media/b.svg', svg(1), 'image/svg+xml'),
    asset('public/media/c.svg', svg(2), 'image/svg+xml'),
    asset('public/media/gone.png', PNG, 'image/png'),
    { ...asset('src/assets/fonts/site/f.woff2', PNG, 'font/woff2'), role: 'font', refs: [] },
  ],
}

async function start(git = fakeGit(files, manifest)) {
  return startMigrationMediaImport({ projectId: 'p-1', workspaceId: 'ws-1', userId: 'u-1', plan: 'starter', usedBytes: 0, git: git as never, contentRoot: '', defaultBranch: 'main' })
}

const deps = (git: ReturnType<typeof fakeGit>) => ({ resolveGit: async () => git as never, resolvePlan: async () => 'starter' as const })

describe('migration media import', () => {
  it('start queues only what can be moved; the rest comes back as skipped; a second start returns the open job', async () => {
    const first = await start()
    expect(first.created).toBe(true)
    expect(store.items.map(i => i.repo_path)).toEqual(['public/media/a.png', 'public/media/b.svg', 'public/media/c.svg'])
    expect(first.skipped).toEqual({ overSize: [], missing: [{ repoPath: 'public/media/gone.png', reason: 'not_in_repo' }], fontsKept: 1 })
    const second = await start()
    expect(second).toMatchObject({ created: false, job: { id: first.job.id } })
  })

  it('a tick imports the batch from the blobs, settles each file and finishes the job', async () => {
    const git = fakeGit(files, manifest)
    await start(git)
    const tick = await runMigrationMediaTick(new Date(), deps(git))
    expect(tick).toMatchObject({ claimed: true, settled: 3, status: 'done' })
    expect(store.jobs[0]).toMatchObject({ status: 'done', done: 3, failed: 0, claim_token: null })
    expect(store.items.every(i => i.state === 'done' && i.delivery_url?.includes('/media/original/'))).toBe(true)
    expect(media.upload.mock.calls.map(c => (c[0] as { source: string }).source)).toEqual(['repo', 'repo', 'repo'])
    expect(await runMigrationMediaTick(new Date(), deps(git))).toEqual({ claimed: false })
  })

  it('a file that is not what it is listed as fails alone; the job still finishes', async () => {
    const git = fakeGit({ ...files, 'public/media/b.svg': Buffer.from('<html><script>alert(1)</script></html>') }, {
      ...manifest,
      assets: manifest.assets.map(a => (a.repoPath === 'public/media/b.svg' ? { ...a, bytes: 38 } : a)),
    })
    await start(git)
    await runMigrationMediaTick(new Date(), deps(git))
    expect(store.jobs[0]).toMatchObject({ status: 'done', done: 2, failed: 1 })
    expect(store.items.find(i => i.repo_path === 'public/media/b.svg')).toMatchObject({ state: 'failed', status_code: 400 })
    expect(toMigrationMediaJobView(store.jobs[0] as never, store.items.filter(i => i.state === 'failed') as never).failures).toEqual([
      { repoPath: 'public/media/b.svg', error: 'media.file_type_not_allowed', statusCode: 400 },
    ])
  })

  it('out of storage: the job pauses with that file still pending; resumed, it continues from there', async () => {
    const git = fakeGit(files, manifest)
    await start(git)
    store.reserveStorageIfAllowed.mockResolvedValueOnce({ allowed: true, currentBytes: 0 }).mockResolvedValueOnce({ allowed: false, currentBytes: 0 })
    const paused = await runMigrationMediaTick(new Date(), deps(git))
    expect(paused).toMatchObject({ status: 'paused_quota', settled: 1 })
    expect(store.jobs[0]).toMatchObject({ status: 'paused_quota', done: 1, error: 'storage.quota_exceeded' })
    expect(store.items.filter(i => i.state === 'pending').map(i => i.repo_path)).toEqual(['public/media/b.svg', 'public/media/c.svg'])
    // A paused job is not claimed until someone resumes it.
    expect(await runMigrationMediaTick(new Date(), deps(git))).toEqual({ claimed: false })

    await store.resumeMigrationMediaJob('p-1', store.jobs[0]!.id)
    expect(await runMigrationMediaTick(new Date(), deps(git))).toMatchObject({ status: 'done', settled: 2 })
    expect(store.jobs[0]).toMatchObject({ status: 'done', done: 3 })
    expect(media.upload).toHaveBeenCalledTimes(3)
  })

  it('a crashed worker\'s lease expires and the next tick takes over; a stale holder can no longer settle', async () => {
    const git = fakeGit(files, manifest)
    await start(git)
    const t0 = new Date('2026-09-25T12:00:00Z')
    const stale = await store.claimMigrationMediaJob(t0, 300)
    expect(await store.claimMigrationMediaJob(new Date(t0.getTime() + 60_000), 300)).toBeNull()
    const takeover = await runMigrationMediaTick(new Date(t0.getTime() + 301_000), deps(git))
    expect(takeover).toMatchObject({ claimed: true, status: 'done', settled: 3 })
    expect(await store.settleMigrationMediaItem({ jobId: stale!.id, token: stale!.claim_token!, repoPath: 'public/media/a.png', ok: true })).toBe(false)
  })

  it('a plan without media upload fails the job with the upgrade message; no media stack claims nothing', async () => {
    const git = fakeGit(files, manifest)
    await start(git)
    expect(await runMigrationMediaTick(new Date(), { media: null })).toEqual({ claimed: false })
    const tick = await runMigrationMediaTick(new Date(), { ...deps(git), resolvePlan: async () => 'free' as never })
    expect(tick).toMatchObject({ status: 'failed', settled: 0 })
    expect(store.jobs[0]).toMatchObject({ status: 'failed', error: 'media.upload_upgrade' })
  })

  it('no manifest: 404; a provider that cannot read blobs: 501', async () => {
    await expect(start(fakeGit(files, null) as never)).rejects.toMatchObject({ statusCode: 422 })
    const noManifest = { ...fakeGit(files, manifest), readFile: vi.fn(async () => Promise.reject(new Error('no'))) }
    await expect(start(noManifest as never)).rejects.toMatchObject({ statusCode: 404 })
    const noBlob = { ...fakeGit(files, manifest), readBlob: undefined }
    await expect(start(noBlob as never)).rejects.toMatchObject({ statusCode: 501 })
  })
})
