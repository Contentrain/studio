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

  it('lets MCP Cloud requests through without consulting the session', async () => {
    await expect(run('/api/mcp/v1/project-123/mcp')).resolves.toBeUndefined()
    // A public path must short-circuit before any session lookup.
    expect(getServerSession).not.toHaveBeenCalled()
  })

  it('still 401s a protected API path when there is no session', async () => {
    getServerSession.mockResolvedValue(null)
    await expect(run('/api/workspaces/w1/projects')).rejects.toMatchObject({ statusCode: 401 })
    expect(getServerSession).toHaveBeenCalled()
  })

  it('ignores non-API routes entirely', async () => {
    await expect(run('/w/acme/projects')).resolves.toBeUndefined()
    expect(getServerSession).not.toHaveBeenCalled()
  })
})
