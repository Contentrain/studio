import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadRequest() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/request-changes.post')).default
}
async function loadResolve() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/[branch]/request-changes.delete')).default
}
async function loadList() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/index.get')).default
}

const BRANCH = 'cr/content/posts/en/1755612345-a3f2'
const PATH = `/api/workspaces/workspace-1/projects/project-1/branches/${encodeURIComponent(BRANCH)}/request-changes`

function stubGlobals(tools: string[] = ['merge_branch', 'reject_branch', 'request_changes']) {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'workspaceId') return 'workspace-1'
    if (key === 'projectId') return 'project-1'
    if (key === 'branch') return BRANCH
    return undefined
  }))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'user-1' }, accessToken: 'token-1' }))
  vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({ availableTools: tools, workspaceRole: 'admin' }))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
}

describe('branch request-changes routes', () => {
  it('opens a request with a comment, announces it, and refuses an empty comment or a non-cr branch', async () => {
    stubGlobals()
    const requestBranchChanges = vi.fn().mockImplementation(async (input: Record<string, string>) => ({ ...input, comment: input.comment, requested_by: input.requestedBy, requested_at: '2026-09-03T12:00:00.000Z' }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ requestBranchChanges }))

    await withTestServer({
      routes: [{ path: PATH, handler: await loadRequest() }],
    }, async ({ request }) => {
      const empty = await request(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comment: '   ' }) })
      expect(empty.status).toBe(400)

      const ok = await request(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comment: 'Shorten the intro' }) })
      expect(ok.status).toBe(200)
      await expect(ok.json()).resolves.toEqual({
        branch: BRANCH,
        changesRequested: { comment: 'Shorten the intro', requestedBy: 'user-1', requestedAt: '2026-09-03T12:00:00.000Z' },
      })
      expect(requestBranchChanges).toHaveBeenCalledWith({ projectId: 'project-1', workspaceId: 'workspace-1', branch: BRANCH, comment: 'Shorten the intro', requestedBy: 'user-1' })
      expect(globalThis.emitWebhookEvent).toHaveBeenCalledWith('project-1', 'workspace-1', 'branch.changes_requested', expect.objectContaining({ branch: BRANCH, comment: 'Shorten the intro' }))
    })
  })

  it('is 403 for a role without the request_changes tool', async () => {
    stubGlobals(['list_branches'])
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ requestBranchChanges: vi.fn() }))
    await withTestServer({
      routes: [{ path: PATH, handler: await loadRequest() }],
    }, async ({ request }) => {
      expect((await request(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comment: 'x' }) })).status).toBe(403)
    })
  })

  it('resolves an open request and 404s when there is none', async () => {
    stubGlobals()
    const resolveBranchChangeRequest = vi.fn().mockResolvedValue(undefined)
    const getBranchChangeRequest = vi.fn().mockResolvedValueOnce({ branch: BRANCH, comment: 'x' }).mockResolvedValueOnce(null)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ getBranchChangeRequest, resolveBranchChangeRequest }))

    await withTestServer({
      routes: [{ path: PATH, handler: await loadResolve() }],
    }, async ({ request }) => {
      expect((await request(PATH, { method: 'DELETE' })).status).toBe(200)
      expect(resolveBranchChangeRequest).toHaveBeenCalledWith('project-1', BRANCH, 'user-1')
      expect((await request(PATH, { method: 'DELETE' })).status).toBe(404)
    })
  })

  it('the branch list flags branches with an open request', async () => {
    stubGlobals()
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: { listBranches: vi.fn().mockResolvedValue([{ name: BRANCH, sha: 'abc', protected: false }, { name: 'cr/content/pages/en/1755612399-b7d1', sha: 'def', protected: false }]) },
      contentRoot: '',
    }))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ models: new Map([['posts', { name: 'Posts' }]]) }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ listBranchChangeRequests: vi.fn().mockResolvedValue([{ branch: BRANCH, comment: 'x' }]) }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/branches', handler: await loadList() }],
    }, async ({ request }) => {
      const body = await (await request('/api/workspaces/workspace-1/projects/project-1/branches')).json() as { branches: Array<{ name: string, changesRequested: boolean, modelName: string | null }> }
      expect(body.branches.map(b => [b.name, b.changesRequested])).toEqual([[BRANCH, true], ['cr/content/pages/en/1755612399-b7d1', false]])
      expect(body.branches[0]!.modelName).toBe('Posts')
    })
  })
})
