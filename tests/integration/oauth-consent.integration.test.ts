import { defineEventHandler } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestCookieJar, withTestServer } from '../helpers/http'

/**
 * The consent leg end-to-end: /oauth/authorize seals the flow cookie, the
 * consent API renders the eligibility tree from it, approve mints the code
 * redirect, deny returns access_denied — and the cookie is single-dance.
 */

const state = vi.hoisted(() => ({
  session: { userId: 'user-1' } as { userId: string } | null,
  auth: { user: { id: 'user-1', email: 'u@example.test' }, accessToken: 'jwt-1' } as Record<string, unknown> | null,
  planOk: true,
  dcrClient: {
    clientId: 'dcr_test1234',
    kind: 'dcr' as const,
    clientName: 'Codex CLI',
    clientUri: null as string | null,
    logoUri: null as string | null,
    redirectUris: ['http://localhost/callback'],
    metadata: {},
    metadataFetchedAt: null as string | null,
  },
  createdCodes: [] as Array<Record<string, unknown>>,
  db: {} as Record<string, unknown>,
}))

vi.mock('~~/server/utils/oauth-server/store', () => ({
  getClient: vi.fn(async (id: string) => (id === state.dcrClient.clientId ? state.dcrClient : null)),
  createAuthorizationCode: vi.fn(async (input: Record<string, unknown>) => {
    state.createdCodes.push(input)
    return `oac_${'f'.repeat(64)}`
  }),
}))

vi.mock('~~/server/utils/oauth-server/cimd', () => ({
  isCimdClientId: (id: string) => id.startsWith('https://'),
  resolveCimdClient: vi.fn(async () => ({ ok: false, error: 'fetch disabled in tests' })),
}))

vi.mock('~~/server/utils/session', () => ({
  getServerSession: vi.fn(async () => state.session),
}))

vi.mock('~~/server/utils/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 29, retryAfterMs: 0 })),
}))

vi.mock('~~/server/utils/providers', () => ({
  useDatabaseProvider: vi.fn(() => state.db),
}))

vi.mock('~~/server/utils/db', () => ({
  requireProjectAccess: vi.fn(async () => {}),
}))

vi.mock('~~/server/utils/license', () => ({
  getWorkspacePlan: vi.fn(() => 'pro'),
  hasFeature: vi.fn(() => state.planOk),
}))

vi.mock('~~/server/utils/content-strings', () => ({
  errorMessage: (key: string) => key,
}))

const managedRuntimeConfig = {
  authProvider: 'managed',
  sessionSecret: 'test-session-secret-32-characters-min',
  public: { siteUrl: 'http://localhost:3000' },
}

function authorizeQuery(): string {
  return new URLSearchParams({
    response_type: 'code',
    client_id: state.dcrClient.clientId,
    redirect_uri: 'http://localhost:54321/callback',
    scope: 'content:read offline_access',
    state: 'client-state-1',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
  }).toString()
}

async function withConsentServer<T>(run: (ctx: {
  request: (path: string, init?: RequestInit) => Promise<Response>
}) => Promise<T>) {
  const authorize = (await import('../../server/routes/oauth/authorize.get')).default
  const consentGet = (await import('../../server/api/oauth/consent.get')).default
  const consentPost = (await import('../../server/api/oauth/consent.post')).default

  // The session middleware isn't mounted here — emulate its contract
  // (event.context.auth) and dispatch GET/POST manually since h3's test app
  // mounts one handler per path.
  const authContext = defineEventHandler((event) => {
    if (state.auth) event.context.auth = state.auth
  })
  const consent = defineEventHandler(event =>
    event.method === 'POST' ? consentPost(event) : consentGet(event))

  return withTestServer({
    middleware: [authContext],
    routes: [
      { path: '/oauth/authorize', handler: authorize },
      { path: '/api/oauth/consent', handler: consent },
    ],
  }, run)
}

/** Run the authorize leg and return a jar holding the flow cookie. */
async function startDance(request: (path: string, init?: RequestInit) => Promise<Response>): Promise<TestCookieJar> {
  const jar = new TestCookieJar()
  const response = await request(`/oauth/authorize?${authorizeQuery()}`, { redirect: 'manual' })
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe('/oauth/consent')
  jar.absorb(response)
  expect(jar.has('contentrain-oauth-authz')).toBe(true)
  return jar
}

describe('OAuth consent flow', () => {
  beforeEach(() => {
    state.session = { userId: 'user-1' }
    state.auth = { user: { id: 'user-1', email: 'u@example.test' }, accessToken: 'jwt-1' }
    state.planOk = true
    state.createdCodes = []
    state.db = {
      listUserWorkspaces: vi.fn(async () => [
        { id: 'ws-1', name: 'Acme', slug: 'acme', plan: 'pro', github_installation_id: 42, overage_settings: {}, workspace_members: [{ role: 'owner' }] },
        { id: 'ws-2', name: 'No App', slug: 'no-app', plan: 'pro', github_installation_id: null, workspace_members: [{ role: 'member' }] },
      ]),
      listUserAssignedProjectIds: vi.fn(async () => []),
      listWorkspaceProjects: vi.fn(async (_token: string, wsId: string) => (wsId === 'ws-1'
        ? [
            { id: 'proj-1', repo_full_name: 'acme/site' },
            { id: 'proj-2', repo_full_name: null },
          ]
        : [])),
      listWorkspaceProjectsByIds: vi.fn(async () => []),
      getProjectById: vi.fn(async () => ({ id: 'proj-1', repo_full_name: 'acme/site', workspace_id: 'ws-1' })),
      getWorkspaceById: vi.fn(async () => ({ id: 'ws-1', github_installation_id: 42, plan: 'pro', overage_settings: {} })),
    }
    vi.stubGlobal('useRuntimeConfig', () => managedRuntimeConfig)
  })

  it('400s the consent API without a pending flow', async () => {
    await withConsentServer(async ({ request }) => {
      const response = await request('/api/oauth/consent')
      expect(response.status).toBe(400)
    })
  })

  it('renders the eligibility tree from the sealed flow', async () => {
    await withConsentServer(async ({ request }) => {
      const jar = await startDance(request)

      const response = await request('/api/oauth/consent', { headers: { cookie: jar.header() } })
      expect(response.status).toBe(200)
      const json = await response.json()

      expect(json.client.displayHost).toBe('Codex CLI') // DCR fallback: no client_uri → name
      expect(json.client.loopbackOnly).toBe(true)
      expect(json.scopes).toEqual(['content:read', 'offline_access'])

      const ws1 = json.workspaces.find((w: { id: string }) => w.id === 'ws-1')
      expect(ws1.eligible).toBe(true)
      expect(ws1.projects).toMatchObject([
        { id: 'proj-1', eligible: true, reason: null },
        { id: 'proj-2', eligible: false, reason: 'ineligible_no_repo' },
      ])

      const ws2 = json.workspaces.find((w: { id: string }) => w.id === 'ws-2')
      expect(ws2).toMatchObject({ eligible: false, reason: 'ineligible_no_installation' })
    })
  })

  it('approve mints the code redirect and burns the flow cookie', async () => {
    await withConsentServer(async ({ request }) => {
      const jar = await startDance(request)

      const response = await request('/api/oauth/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cookie': jar.header(), 'origin': 'http://localhost:3000' },
        body: JSON.stringify({ decision: 'approve', workspaceId: 'ws-1', projectId: 'proj-1' }),
      })
      expect(response.status).toBe(200)
      const { redirectTo } = await response.json()

      const target = new URL(redirectTo)
      expect(`${target.protocol}//${target.host}${target.pathname}`).toBe('http://localhost:54321/callback')
      expect(target.searchParams.get('code')).toMatch(/^oac_/)
      expect(target.searchParams.get('state')).toBe('client-state-1')

      // The code carries the validated selection + PKCE challenge.
      expect(state.createdCodes[0]).toMatchObject({
        clientId: 'dcr_test1234',
        userId: 'user-1',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        scope: 'content:read offline_access',
        codeChallenge: 'a'.repeat(43),
      })

      // Cookie burned — the dance is single-use.
      jar.absorb(response)
      const replay = await request('/api/oauth/consent', { headers: { cookie: jar.header() } })
      expect(replay.status).toBe(400)
    })
  })

  it('deny returns access_denied to the client', async () => {
    await withConsentServer(async ({ request }) => {
      const jar = await startDance(request)

      const response = await request('/api/oauth/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cookie': jar.header(), 'origin': 'http://localhost:3000' },
        body: JSON.stringify({ decision: 'deny' }),
      })
      const { redirectTo } = await response.json()
      const target = new URL(redirectTo)
      expect(target.searchParams.get('error')).toBe('access_denied')
      expect(target.searchParams.get('state')).toBe('client-state-1')
      expect(state.createdCodes).toHaveLength(0)
    })
  })

  it('approve re-validates the plan gate server-side', async () => {
    await withConsentServer(async ({ request }) => {
      const jar = await startDance(request)
      state.planOk = false

      const response = await request('/api/oauth/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cookie': jar.header(), 'origin': 'http://localhost:3000' },
        body: JSON.stringify({ decision: 'approve', workspaceId: 'ws-1', projectId: 'proj-1' }),
      })
      expect(response.status).toBe(403)
      expect(state.createdCodes).toHaveLength(0)
    })
  })

  it('rejects cross-origin consent decisions', async () => {
    await withConsentServer(async ({ request }) => {
      const jar = await startDance(request)

      const response = await request('/api/oauth/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cookie': jar.header(), 'origin': 'https://evil.example' },
        body: JSON.stringify({ decision: 'approve', workspaceId: 'ws-1', projectId: 'proj-1' }),
      })
      expect(response.status).toBe(403)
    })
  })

  it('401s without a Studio session', async () => {
    state.auth = null
    await withConsentServer(async ({ request }) => {
      const response = await request('/api/oauth/consent')
      expect(response.status).toBe(401)
    })
  })
})
