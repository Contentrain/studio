import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for the server auth middleware's public-path
 * allowlist. The MCP Cloud endpoint (`/api/mcp/...`) authenticates with a
 * Bearer `mcp_cloud_keys` token inside the route handler, not with a
 * session cookie — so the session middleware must let it through. A
 * missing exemption 401s every external-agent request before the route
 * (and its Bearer-key auth) can run.
 */
describe('auth middleware public paths', () => {
  const getServerSession = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    getServerSession.mockReset()
    vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => {
      const err = new Error(input.message) as Error & { statusCode: number }
      err.statusCode = input.statusCode
      return err
    })
    vi.stubGlobal('errorMessage', (key: string) => key)
    vi.stubGlobal('getServerSession', getServerSession)
    vi.stubGlobal('clearServerSession', vi.fn())
    vi.stubGlobal('setServerSession', vi.fn())
    vi.stubGlobal('useAuthProvider', () => ({
      validateToken: vi.fn().mockResolvedValue({ id: 'user-1' }),
      refreshSession: vi.fn(),
    }))
  })

  async function run(path: string) {
    vi.stubGlobal('getRequestPath', () => path)
    const handler = (await import('../../server/middleware/01.auth')).default as (e: unknown) => Promise<unknown>
    return handler({ context: {} })
  }

  // Every external surface that authenticates itself inside the route
  // (Bearer key / webhook signature / captcha) must short-circuit before
  // any session lookup, or the middleware 401s the request first.
  it.each([
    '/api/mcp/v1/project-123/mcp', // MCP Cloud — Bearer key
    '/api/forms/v1/project-123/contact/submit', // public form submit — captcha
    '/api/forms/v1/project-123/contact/config', // public form config
    '/api/comments/v1/project-123/posts/entry-1', // public comment read + submit — captcha + rate limit
    '/api/conversation/v1/project-123/message', // Conversation API — Bearer key
    '/api/cdn/v1/project-123/img/logo.png', // CDN — Bearer key
    '/api/webhooks/github', // GitHub webhook — HMAC signature
    '/api/billing/webhook/polar', // billing webhook — provider signature
    '/api/_auth/session', // nuxt-auth-utils module session — own sealed cookie
    '/api/auth/review-login', // directory-review password login — env-gated, pre-session
  ])('lets self-authenticating external endpoint %s through without a session lookup', async (path) => {
    await expect(run(path)).resolves.toBeUndefined()
    expect(getServerSession).not.toHaveBeenCalled()
  })

  // Migrate's signed server-to-server calls: no session, the route verifies the signature.
  it.each([
    '/api/migrate/account-state',
    '/api/migrate/provision',
    '/api/migrate/grants/status',
    '/api/migrate/grants/install-url',
  ])('lets Migrate\'s signed server-to-server call %s through without a session lookup', async (path) => {
    await expect(run(path)).resolves.toBeUndefined()
    expect(getServerSession).not.toHaveBeenCalled()
  })

  // The allowlist is exact paths: the user-facing Migrate routes keep their session.
  it.each([
    '/api/migrate/claim',
    '/api/migrate/grants/grant-1',
    '/api/migrate/grants/grant-1/checkout',
    '/api/migrate/grants/status/extra',
    '/api/migrate/account-state/extra',
  ])('still 401s the user-facing Migrate route %s without a session', async (path) => {
    getServerSession.mockResolvedValue(null)
    await expect(run(path)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('still 401s a protected API path when there is no session', async () => {
    getServerSession.mockResolvedValue(null)
    await expect(run('/api/workspaces/w1/projects')).rejects.toMatchObject({ statusCode: 401 })
    expect(getServerSession).toHaveBeenCalled()
  })

  // The OAuth consent API renders workspace/project data for the signed-in
  // user — it must stay session-guarded even though the /oauth/* protocol
  // endpoints (server/routes/, outside this middleware) are public.
  it('keeps /api/oauth/consent session-guarded', async () => {
    getServerSession.mockResolvedValue(null)
    await expect(run('/api/oauth/consent')).rejects.toMatchObject({ statusCode: 401 })
    expect(getServerSession).toHaveBeenCalled()
  })

  it('ignores non-API routes entirely', async () => {
    await expect(run('/w/acme/projects')).resolves.toBeUndefined()
    expect(getServerSession).not.toHaveBeenCalled()
  })
})

describe('auth middleware: Migrate install callback', () => {
  const getServerSession = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    getServerSession.mockReset().mockResolvedValue(null)
    vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
    vi.stubGlobal('errorMessage', (key: string) => key)
    vi.stubGlobal('getServerSession', getServerSession)
    vi.stubGlobal('clearServerSession', vi.fn())
    vi.stubGlobal('looksLikeMigrateInstallState', (v: unknown) => typeof v === 'string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(v))
  })

  async function run(path: string, state?: string) {
    // Like h3's getRequestPath: the query string stays on the path.
    vi.stubGlobal('getRequestPath', () => (state === undefined ? path : `${path}?installation_id=555&code=c&state=${state}`))
    vi.stubGlobal('getQuery', () => (state === undefined ? {} : { state }))
    const handler = (await import('../../server/middleware/01.auth')).default as (e: unknown) => Promise<unknown>
    return handler({ context: {} })
  }

  it('lets the GitHub setup callback through unauthenticated only for a signed (token-shaped) state', async () => {
    await expect(run('/api/github/setup', 'aaa.bbb.ccc')).resolves.toBeUndefined()
    expect(getServerSession).not.toHaveBeenCalled()
    await expect(run('/api/github/setup', '3f2b1c9e-6c7a-4e1f-9d1a-2b3c4d5e6f70')).rejects.toMatchObject({ statusCode: 401 })
    await expect(run('/api/github/setup')).rejects.toMatchObject({ statusCode: 401 })
    await expect(run('/api/github/repos', 'aaa.bbb.ccc')).rejects.toMatchObject({ statusCode: 401 })
  })
})
