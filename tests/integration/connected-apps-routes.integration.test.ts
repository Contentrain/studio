import { defineEventHandler } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

/**
 * Connected Apps management routes — role matrix (owner/admin see and
 * revoke everything; a member only their own), month-usage join, client
 * identity derivation, and the managed-pair gating shape (GET degrades to
 * enabled:false, DELETE 404s).
 */

const state = vi.hoisted(() => ({
  auth: { user: { id: 'user-1', email: 'u@example.test' }, accessToken: 'jwt-1' } as Record<string, unknown> | null,
  role: 'owner' as string,
  grants: [] as Array<Record<string, unknown>>,
  usage: {} as Record<string, number>,
  workspaceGrant: null as Record<string, unknown> | null,
  revokeGrant: vi.fn(async () => true),
}))

vi.mock('~~/server/utils/providers', () => ({
  useDatabaseProvider: vi.fn(() => ({
    requireWorkspaceRole: vi.fn(async () => state.role),
  })),
}))

vi.mock('~~/server/utils/oauth-server/store', () => ({
  listWorkspaceGrants: vi.fn(async () => state.grants),
  getWorkspaceOauthMonthUsage: vi.fn(async () => state.usage),
  getWorkspaceGrant: vi.fn(async () => state.workspaceGrant),
  revokeGrant: (...args: unknown[]) => state.revokeGrant(...args as []),
}))

vi.mock('~~/server/utils/content-strings', () => ({
  errorMessage: (key: string) => key,
}))

const managedRuntimeConfig = {
  authProvider: 'managed',
  public: { siteUrl: 'https://studio.example' },
}

function cimdGrant(overrides: Record<string, unknown> = {}) {
  return {
    grantId: 'grant-1',
    userId: 'user-1',
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    clientName: 'Claude Code',
    clientUri: null,
    logoUri: null,
    projectId: 'proj-1',
    projectRepo: 'acme/site',
    scope: 'content:read content:write offline_access',
    createdAt: '2026-07-01T00:00:00Z',
    lastUsedAt: null,
    ...overrides,
  }
}

async function withRoutes<T>(run: (ctx: {
  request: (path: string, init?: RequestInit) => Promise<Response>
}) => Promise<T>) {
  const list = (await import('../../server/api/workspaces/[workspaceId]/connected-apps/index.get')).default
  const remove = (await import('../../server/api/workspaces/[workspaceId]/connected-apps/[grantId].delete')).default

  const authContext = defineEventHandler((event) => {
    if (state.auth) event.context.auth = state.auth
    // The test app mounts below the params Nitro would extract — inject them.
    const match = event.path.match(/^\/api\/workspaces\/([^/]+)\/connected-apps\/?([^/?]*)/)
    event.context.params = {
      workspaceId: match?.[1] ?? '',
      ...(match?.[2] ? { grantId: match[2] } : {}),
    }
  })
  const dispatch = defineEventHandler(event =>
    event.method === 'DELETE' ? remove(event) : list(event))

  return withTestServer({
    middleware: [authContext],
    routes: [{ path: '/api/workspaces', handler: dispatch }],
  }, run)
}

describe('connected-apps routes', () => {
  beforeEach(() => {
    state.auth = { user: { id: 'user-1', email: 'u@example.test' }, accessToken: 'jwt-1' }
    state.role = 'owner'
    state.grants = [
      cimdGrant(),
      cimdGrant({ grantId: 'grant-2', userId: 'user-2', clientId: 'dcr_abc', clientName: 'Codex CLI', clientUri: null }),
    ]
    state.usage = { 'grant-1': 12 }
    state.workspaceGrant = cimdGrant()
    state.revokeGrant = vi.fn(async () => true)
    vi.stubGlobal('useRuntimeConfig', () => managedRuntimeConfig)
  })

  it('owners see every grant, with month usage and derived client identity', async () => {
    await withRoutes(async ({ request }) => {
      const response = await request('/api/workspaces/ws-1/connected-apps')
      expect(response.status).toBe(200)
      const json = await response.json()

      expect(json.enabled).toBe(true)
      expect(json.endpoint).toBe('https://studio.example/api/mcp/remote')
      expect(json.grants).toHaveLength(2)

      const [cimd, dcr] = json.grants
      // CIMD identity = client_id URL host; DCR falls back to client_name.
      expect(cimd.clientHost).toBe('claude.ai')
      expect(cimd.callsThisMonth).toBe(12)
      expect(cimd.mine).toBe(true)
      expect(cimd.scopes).toEqual(['content:read', 'content:write', 'offline_access'])
      expect(dcr.clientHost).toBe('Codex CLI')
      expect(dcr.callsThisMonth).toBe(0)
      expect(dcr.mine).toBe(false)
    })
  })

  it('members only see their own grants', async () => {
    state.role = 'member'
    await withRoutes(async ({ request }) => {
      const response = await request('/api/workspaces/ws-1/connected-apps')
      const json = await response.json()
      expect(json.grants).toHaveLength(1)
      expect(json.grants[0].grantId).toBe('grant-1')
    })
  })

  it('degrades to enabled:false on the Supabase pair instead of erroring', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ ...managedRuntimeConfig, authProvider: 'supabase' }))
    await withRoutes(async ({ request }) => {
      const response = await request('/api/workspaces/ws-1/connected-apps')
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ enabled: false, endpoint: null, grants: [] })
    })
  })

  it('admins revoke any grant', async () => {
    state.role = 'admin'
    state.workspaceGrant = cimdGrant({ userId: 'user-2' })
    await withRoutes(async ({ request }) => {
      const response = await request('/api/workspaces/ws-1/connected-apps/grant-2', { method: 'DELETE' })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ revoked: true })
      expect(state.revokeGrant).toHaveBeenCalledWith('grant-2', 'ws-1')
    })
  })

  it('members revoke their own grants but not others’', async () => {
    state.role = 'member'
    state.workspaceGrant = cimdGrant({ userId: 'user-1' })
    await withRoutes(async ({ request }) => {
      const own = await request('/api/workspaces/ws-1/connected-apps/grant-1', { method: 'DELETE' })
      expect(own.status).toBe(200)
    })

    state.workspaceGrant = cimdGrant({ grantId: 'grant-2', userId: 'user-2' })
    await withRoutes(async ({ request }) => {
      const foreign = await request('/api/workspaces/ws-1/connected-apps/grant-2', { method: 'DELETE' })
      expect(foreign.status).toBe(403)
    })
  })

  it('404s revocation of unknown grants and on the Supabase pair', async () => {
    state.workspaceGrant = null
    await withRoutes(async ({ request }) => {
      const missing = await request('/api/workspaces/ws-1/connected-apps/nope', { method: 'DELETE' })
      expect(missing.status).toBe(404)
    })

    vi.stubGlobal('useRuntimeConfig', () => ({ ...managedRuntimeConfig, authProvider: 'supabase' }))
    await withRoutes(async ({ request }) => {
      const gated = await request('/api/workspaces/ws-1/connected-apps/grant-1', { method: 'DELETE' })
      expect(gated.status).toBe(404)
    })
  })

  it('401s without a session', async () => {
    state.auth = null
    await withRoutes(async ({ request }) => {
      const response = await request('/api/workspaces/ws-1/connected-apps')
      expect(response.status).toBe(401)
    })
  })
})
