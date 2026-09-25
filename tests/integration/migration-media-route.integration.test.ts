import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

/**
 * GET …/migration/media — the preflight for moving a migration's media into
 * Studio Media, through the real route: roles, the media stack gate, the
 * manifest read from the content branch, the plan's limits and upgrade.
 */

async function loadRoute() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/migration/media.get')).default
}

const WORKSPACE = 'workspace-1'
const PROJECT = 'project-1'
const URL_PATH = '/api/workspaces/workspace-1/projects/project-1/migration/media'
const MB = 1024 * 1024
const LIMITS: Record<string, Record<string, number>> = {
  starter: { 'media.storage_gb': 1, 'media.max_file_size_mb': 5 },
  pro: { 'media.storage_gb': 15, 'media.max_file_size_mb': 50 },
}

const manifest = {
  version: 1,
  origin: 'https://old.example',
  assets: [
    { id: 'a', role: 'media', repoPath: 'public/media/a.png', localUrl: '/media/a.png', sha256: 'a'.repeat(64), bytes: 6 * MB, mime: 'image/png', refs: [{ file: 'content/blog/en.json', pointer: '/p1/cover', match: 'exact' }] },
    { id: 'b', role: 'media', repoPath: 'public/media/b.svg', localUrl: '/media/b.svg', sha256: 'b'.repeat(64), bytes: 1000, mime: 'image/svg+xml', refs: [{ file: 'content/blog/en.json', pointer: '/p1/body', match: 'contains' }] },
    { id: 'f', role: 'font', repoPath: 'src/assets/fonts/site/f.woff2', sha256: 'f'.repeat(64), bytes: 500, mime: 'font/woff2', refs: [] },
  ],
}

function stub(opts: { role?: string, plan?: string, media?: boolean, manifestText?: string | null, upload?: boolean } = {}) {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => (key === 'workspaceId' ? WORKSPACE : key === 'projectId' ? PROJECT : undefined)))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'user-1' }, accessToken: 'token-1' }))
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue(opts.plan ?? 'starter'))
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(opts.upload ?? true))
  vi.stubGlobal('getPlanLimit', (plan: string, key: string) => LIMITS[plan]?.[key] ?? 0)
  vi.stubGlobal('getPlanLimitForPlan', (plan: string, key: string) => LIMITS[plan]?.[key] ?? 0)
  vi.stubGlobal('getUpgradeParams', (from: string, to?: string) => ({ plan: from, toPlan: to ?? 'next' }))
  vi.stubGlobal('useMediaProvider', () => (opts.media === false ? null : {}))
  const readFile = vi.fn(async (path: string, ref: string) => {
    if (opts.manifestText === null || path !== '.contentrain/migrate/media.json' || ref !== 'contentrain') throw new Error('not found')
    return opts.manifestText ?? JSON.stringify(manifest)
  })
  const getTree = vi.fn(async () => [
    { path: 'public/media/a.png', type: 'blob', sha: 's1', size: 6 * MB },
    { path: 'public/media/b.svg', type: 'blob', sha: 's2', size: 1000 },
  ])
  vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({ git: { readFile, getTree }, contentRoot: '', project: { default_branch: 'main' } }))
  const db = {
    requireWorkspaceRole: vi.fn().mockResolvedValue(opts.role ?? 'owner'),
    getProjectForWorkspace: vi.fn().mockResolvedValue({ id: PROJECT }),
    getProjectMember: vi.fn().mockResolvedValue(null),
    getWorkspaceById: vi.fn().mockResolvedValue({ id: WORKSPACE, plan: opts.plan ?? 'starter', overage_settings: null, media_storage_bytes: 1000 }),
  }
  vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db))
  return { readFile, getTree, db }
}

async function call(): Promise<{ status: number, body: Record<string, unknown> }> {
  let out!: { status: number, body: Record<string, unknown> }
  await withTestServer({ routes: [{ path: URL_PATH, handler: await loadRoute() }] }, async ({ request }) => {
    const res = await request(URL_PATH)
    out = { status: res.status, body: await res.json() as Record<string, unknown> }
  })
  return out
}

describe('migration media preflight route', () => {
  it('Starter: counts media (fonts kept), lists the file over 5 MB, and names Pro', async () => {
    const { getTree } = stub()
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body).toMatchObject({ present: true, manifest: { path: '.contentrain/migrate/media.json', ref: 'contentrain' }, uploadAllowed: true })
    expect(body.preflight).toMatchObject({
      count: 2,
      totalBytes: 6 * MB + 1000,
      fontsKept: 1,
      refs: 2,
      overSize: [{ repoPath: 'public/media/a.png', bytes: 6 * MB }],
      missing: [],
      fits: true,
      storage: { usedBytes: 1000 },
      upgrade: { plan: 'pro' },
    })
    expect(getTree).toHaveBeenCalledWith('contentrain')
  })

  it('no manifest: present false', async () => {
    stub({ manifestText: null })
    expect((await call()).body).toEqual({ present: false })
  })

  it('a malformed manifest is a 422 (which field: migration-media.test.ts)', async () => {
    stub({ manifestText: JSON.stringify({ version: 1, assets: [{ repoPath: '../x.png' }] }) })
    expect((await call()).status).toBe(422)
  })

  it('no media stack (Community Edition): 503, the repository is not read', async () => {
    const { readFile } = stub({ media: false })
    expect((await call()).status).toBe(503)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('a member without the project: 403', async () => {
    stub({ role: 'member' })
    expect((await call()).status).toBe(403)
  })

  it('a plan without media upload: the preflight still answers, with the upgrade params', async () => {
    stub({ upload: false })
    const { body } = await call()
    expect(body).toMatchObject({ present: true, uploadAllowed: false, upgradeParams: { plan: 'starter' } })
  })
})
