import { canonicalStringify } from '@contentrain/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

/**
 * POST …/migration/media/apply through the real route: dry run by default,
 * one commit on a cr/ branch, the project's workflow deciding whether it lands.
 */

const helpers = vi.hoisted(() => ({
  createFeatureBranch: vi.fn(async () => ({ branchName: 'cr/media/migration/1' })),
  openWriteSnapshot: vi.fn(),
  writeBase: vi.fn(() => 'base-sha'),
}))
vi.mock('../../server/utils/content-engine/helpers', () => helpers)

const PATH = '/api/workspaces/workspace-1/projects/project-1/migration/media/apply'
const manifest = {
  version: 1,
  assets: [{ id: 'a', repoPath: 'public/media/a.png', localUrl: '/media/a.png', sha256: '0'.repeat(64), bytes: 10, mime: 'image/png', refs: [{ file: 'content/blog/en.json', pointer: '/p1/cover', match: 'exact' }] }],
}
const DELIVERY = 'https://studio.test/api/cdn/v1/project-1/media/original/a.png'

let applyPlan: ReturnType<typeof vi.fn>
let mergeBranch: ReturnType<typeof vi.fn>
let deleteBranch: ReturnType<typeof vi.fn>

function stub(opts: { workflow?: string, reviewFeature?: boolean, jobStatus?: string, mergeResult?: unknown, mergeThrows?: boolean } = {}) {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => (key === 'workspaceId' ? 'workspace-1' : key === 'projectId' ? 'project-1' : undefined)))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'user-1', email: 'owner@acme.dev' }, accessToken: 't' }))
  vi.stubGlobal('checkRateLimit', vi.fn().mockResolvedValue({ allowed: true }))
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
  vi.stubGlobal('hasFeature', vi.fn((_: string, f: string) => f === 'workflow.review' ? (opts.reviewFeature ?? true) : true))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.test' } }))
  vi.stubGlobal('invalidateBrainCache', vi.fn())
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { workflow: opts.workflow ?? 'auto-merge' } }))
  applyPlan = vi.fn(async () => ({ sha: 'commit-1' }))
  deleteBranch = vi.fn(async () => {})
  mergeBranch = vi.fn(async () => {
    if (opts.mergeThrows) throw Object.assign(new Error('conflict'), { status: 409 })
    return opts.mergeResult ?? { merged: true, sha: 'm', pullRequestUrl: null }
  })
  const files: Record<string, string> = {
    '.contentrain/migrate/media.json': JSON.stringify(manifest),
    'content/blog/en.json': canonicalStringify({ p1: { cover: '/media/a.png' } }),
  }
  const git = {
    readFile: vi.fn(async (path: string) => {
      if (files[path]) return files[path]
      throw new Error('not found')
    }),
    applyPlan,
    deleteBranch,
    getTree: vi.fn(async () => Object.keys(files).map(path => ({ path, type: 'blob', sha: path, size: files[path]!.length }))),
  }
  helpers.openWriteSnapshot.mockResolvedValue({ baseSha: 'base-sha', reader: { readFile: async (path: string) => files[path] ?? Promise.reject(new Error('nf')) } })
  vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({ git, contentRoot: '', workspace: { plan: 'pro' }, project: { default_branch: 'main' } }))
  vi.stubGlobal('createContentEngine', vi.fn(() => ({ ensureContentBranch: vi.fn(async () => {}), mergeBranch })))
  vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
    requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
    getProjectForWorkspace: vi.fn().mockResolvedValue({ id: 'project-1' }),
    getLatestMigrationMediaJob: vi.fn().mockResolvedValue({ id: 'job-1', status: opts.jobStatus ?? 'done' }),
    listMigrationMediaItems: vi.fn().mockResolvedValue([{ repo_path: 'public/media/a.png', delivery_url: DELIVERY }]),
  }))
}

async function call(body: Record<string, unknown>): Promise<{ status: number, body: Record<string, unknown> }> {
  const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/migration/media/apply.post')).default
  let out!: { status: number, body: Record<string, unknown> }
  await withTestServer({ routes: [{ path: PATH, method: 'POST', handler }] as never }, async ({ request }) => {
    const res = await request(PATH, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    out = { status: res.status, body: await res.json() as Record<string, unknown> }
  })
  return out
}

beforeEach(() => {
  helpers.createFeatureBranch.mockClear()
})

describe('migration media apply route', () => {
  it('dry run by default: the counts, nothing written', async () => {
    stub()
    const { body } = await call({})
    expect(body).toMatchObject({ status: 'dry_run', counts: { rewritten: 1, studioBinding: 'written', keptBecause: 'not_requested' } })
    expect(applyPlan).not.toHaveBeenCalled()
  })

  it('auto-merge: one commit on a cr/ branch from the read snapshot, then landed', async () => {
    stub()
    const { body } = await call({ dryRun: false, deleteLocal: true })
    expect(body).toMatchObject({ status: 'merged', branch: 'cr/media/migration/1', counts: { deleted: 1 } })
    const input = applyPlan.mock.calls[0]![0] as { base: string, changes: Array<{ path: string, content: string | null }> }
    expect(input.base).toBe('base-sha')
    expect(input.changes.map(c => [c.path, c.content === null])).toEqual([
      ['content/blog/en.json', false], ['public/media/a.png', true], ['studio.json', false],
    ])
    expect(mergeBranch).toHaveBeenCalledWith('cr/media/migration/1')
    // What a reviewer reads on the branch names every site file it touches.
    const message = (applyPlan.mock.calls[0]![0] as { message: string }).message
    expect(message).toContain('Site file: studio.json')
    expect(message).toContain('Removed 1 local media files')
    expect(message).toContain('  - public/media/a.png')
  })

  it('review workflow: the branch is left pending for a reviewer', async () => {
    stub({ workflow: 'review' })
    const { body } = await call({ dryRun: false })
    expect(body).toMatchObject({ status: 'pending_review', branch: 'cr/media/migration/1' })
    expect(mergeBranch).not.toHaveBeenCalled()
  })

  it('review configured but not on the plan: auto-merge, like every other write', async () => {
    stub({ workflow: 'review', reviewFeature: false })
    expect((await call({ dryRun: false })).body.status).toBe('merged')
  })

  it('import not finished: 409, nothing read', async () => {
    stub({ jobStatus: 'running' })
    expect((await call({ dryRun: false })).status).toBe(409)
    expect(applyPlan).not.toHaveBeenCalled()
  })

  it('a write that landed since the read: 409, the branch is removed, nothing overwritten', async () => {
    stub({ mergeThrows: true })
    expect((await call({ dryRun: false })).status).toBe(409)
    expect(deleteBranch).toHaveBeenCalledWith('cr/media/migration/1')
  })
})
