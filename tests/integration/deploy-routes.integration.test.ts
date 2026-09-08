import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadGet() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/deploy/index.get')).default
}
async function loadPatch() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/deploy/index.patch')).default
}
async function loadDelete() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/deploy/index.delete')).default
}
async function loadTrigger() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/deploy/trigger.post')).default
}

const SECRET = 'test-session-secret-32-characters-min'
const PATH = '/api/workspaces/workspace-1/projects/project-1/deploy'

function stubGlobals(deployTarget: unknown = null) {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'workspaceId') return 'workspace-1'
    if (key === 'projectId') return 'project-1'
    return undefined
  }))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'user-1' }, accessToken: 'token-1' }))
  vi.stubGlobal('useRuntimeConfig', () => ({ sessionSecret: SECRET, sessionSecretPrevious: '', public: { siteUrl: 'https://studio.test' } }))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
  const db = {
    requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
    getProjectForWorkspace: vi.fn().mockResolvedValue({ id: 'project-1', deploy_target: deployTarget }),
    getProjectById: vi.fn().mockResolvedValue({ id: 'project-1', workspace_id: 'workspace-1', deploy_target: deployTarget }),
    setProjectDeployTarget: vi.fn().mockResolvedValue(undefined),
    listPendingScheduledPublications: vi.fn().mockResolvedValue([{ id: 's1', model_id: 'posts', entry_id: 'e1', locale: 'en', kind: 'publish', fire_at: '2026-09-04T09:00:00.000Z' }]),
  }
  vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db))
  return db
}

describe('deploy hook routes', () => {
  it('PATCH stores an encrypted target and returns only a hint; GET reads it back with the pending schedule', async () => {
    const db = stubGlobals()

    await withTestServer({
      routes: [{ path: PATH, handler: await loadPatch() }],
    }, async ({ request }) => {
      const bad = await request(PATH, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'netlify', hookUrl: 'http://insecure.example/hook' }) })
      expect(bad.status).toBe(400)

      const ok = await request(PATH, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'netlify', hookUrl: 'https://api.netlify.com/build_hooks/abcd1234efgh', triggers: { on_schedule: false } }) })
      expect(ok.status).toBe(200)
      const body = await ok.json() as { target: Record<string, unknown> }
      expect(body.target).toMatchObject({ provider: 'netlify', hookHint: 'api.netlify.com/…efgh', triggers: { on_publish: true, on_schedule: false } })
      expect(JSON.stringify(body)).not.toContain('abcd1234')

      const stored = db.setProjectDeployTarget.mock.calls[0]![1] as Record<string, unknown>
      expect(stored.hook_url_encrypted).toBeTypeOf('string')
      expect(String(stored.hook_url_encrypted)).not.toContain('build_hooks')
    })

    const stored = db.setProjectDeployTarget.mock.calls[0]![1]
    stubGlobals(stored)
    await withTestServer({
      routes: [{ path: PATH, handler: await loadGet() }],
    }, async ({ request }) => {
      const response = await request(PATH)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        target: { provider: 'netlify', hookHint: 'api.netlify.com/…efgh' },
        scheduled: [{ modelId: 'posts', entryId: 'e1', kind: 'publish' }],
      })
    })
  })

  it('DELETE clears the target; trigger fires the hook immediately and reports its status', async () => {
    const db = stubGlobals()
    await withTestServer({
      routes: [{ path: PATH, handler: await loadDelete() }],
    }, async ({ request }) => {
      expect((await request(PATH, { method: 'DELETE' })).status).toBe(200)
      expect(db.setProjectDeployTarget).toHaveBeenCalledWith('project-1', null)
    })

    // No target → 404
    stubGlobals(null)
    await withTestServer({
      routes: [{ path: `${PATH}/trigger`, handler: await loadTrigger() }],
    }, async ({ request }) => {
      expect((await request(`${PATH}/trigger`, { method: 'POST' })).status).toBe(404)
    })

    // With a target → the hook is POSTed
    const { encodeDeployTarget } = await import('../../server/utils/deploy-hooks')
    const target = encodeDeployTarget({ provider: 'generic', hookUrl: 'https://hooks.example.com/rebuild' })
    stubGlobals(target)
    // Only the hook host is faked — the test client itself talks to the local server over the real fetch.
    const realFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith('https://hooks.example.com') ? fetchMock(input, init) : realFetch(input, init))
    await withTestServer({
      routes: [{ path: `${PATH}/trigger`, handler: await loadTrigger() }],
    }, async ({ request }) => {
      const response = await request(`${PATH}/trigger`, { method: 'POST' })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true, status: 200 })
      expect(fetchMock).toHaveBeenCalledWith('https://hooks.example.com/rebuild', expect.objectContaining({ method: 'POST' }))
      const sent = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>
      expect(sent).toMatchObject({ source: 'contentrain-studio', reason: 'manual' })
    })
  })
})
