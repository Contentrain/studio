import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Workspace and project ids go from the URL path straight into queries
 * against `uuid` columns, so a segment that is not a uuid does not read
 * as "not found" — Postgres rejects the literal and the request 500s.
 * That is how `/api/workspaces/:id/projects/new/` behaved once the
 * `projects/new` page was removed and the path started falling through
 * to the `[projectId]` route (#295).
 *
 * The guard is a middleware rather than a check per handler because
 * there are twenty-odd routes under `[projectId]` across five trees and
 * none of them had one.
 */
vi.mock('../../server/utils/content-strings', () => ({
  errorMessage: (key: string) => key,
}))

describe('path id guard', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => {
      const err = new Error(input.message) as Error & { statusCode: number }
      err.statusCode = input.statusCode
      return err
    })
  })

  async function run(path: string) {
    vi.stubGlobal('getRequestPath', () => path)
    const handler = (await import('../../server/middleware/02b.path-ids')).default as (e: unknown) => unknown
    return handler({})
  }

  const WS = '11111111-2222-4333-8444-555555555555'
  const UUID = '9f0dbe16-0f8e-4a4e-9a1e-9c0f1b2c3d4e'

  describe('project id', () => {
    // The reported path, plus the same shape on every other tree that
    // takes a project id from the URL.
    it.each([
      `/api/workspaces/${WS}/projects/new`,
      `/api/workspaces/${WS}/projects/new/`, // the trailing slash Sentry recorded
      `/api/workspaces/${WS}/projects/new/content`,
      '/api/media/v1/new/assets',
      '/api/mcp/v1/not-a-uuid/mcp',
      '/api/comments/v1/undefined/blog/entry-1',
      '/api/forms/v1/null/contact/submit',
    ])('answers 404 for %s', async (path) => {
      await expect(async () => run(path)).rejects.toMatchObject({
        statusCode: 404,
        message: 'project.not_found',
      })
    })

    it.each([
      `/api/workspaces/${WS}/projects/${UUID}`,
      `/api/workspaces/${WS}/projects/${UUID}/content/blog`,
      `/api/workspaces/${WS}/projects/${UUID.toUpperCase()}`, // uuid case is not significant
      `/api/media/v1/${UUID}/assets`,
      `/api/mcp/v1/${UUID}/mcp`,
      `/api/comments/v1/${UUID}/blog/entry-1`,
      `/api/forms/v1/${UUID}/contact/submit`,
    ])('lets %s through', async (path) => {
      await expect(run(path)).resolves.toBeUndefined()
    })
  })

  describe('workspace id', () => {
    // One segment earlier, same column type, same 500 — reached through
    // the billing middleware's own `getWorkspaceById`.
    it.each([
      '/api/workspaces/not-a-uuid',
      '/api/workspaces/undefined/projects',
      `/api/workspaces/new/projects/${UUID}`,
      '/api/workspaces/me/settings',
    ])('answers 404 for %s', async (path) => {
      await expect(async () => run(path)).rejects.toMatchObject({
        statusCode: 404,
        message: 'workspace.not_found',
      })
    })

    it('reports the workspace, not the project, when both are malformed', async () => {
      // The outer id is the one that fails first in the handler chain, so
      // naming the inner one would point at the wrong segment.
      await expect(async () => run('/api/workspaces/nope/projects/also-nope'))
        .rejects.toMatchObject({ message: 'workspace.not_found' })
    })

    it.each([
      `/api/workspaces/${WS}`,
      `/api/workspaces/${WS}/settings`,
      `/api/workspaces/${WS}/billing/portal`,
      `/api/workspaces/${WS}/projects`,
    ])('lets %s through', async (path) => {
      await expect(run(path)).resolves.toBeUndefined()
    })
  })

  it.each([
    '/api/workspaces', // the collection route
    '/api/workspaces/', // and a trailing slash on it
    `/api/workspaces/${WS}/projects/`, // trailing slash on the project collection
    '/api/mcp/remote/authorize', // OAuth surface — carries no project id
    '/api/profile',
    '/api/billing/checkout', // workspaceId lives in the body here, not the path
    '/api/cdn/v1/anything', // a tree the guard does not cover
    '/auth/login', // not an API path at all
  ])('does not touch %s', async (path) => {
    await expect(run(path)).resolves.toBeUndefined()
  })

  describe('query strings', () => {
    // `getRequestPath` hands back the query too, and an id is often the
    // last segment — so `?expand=1` would otherwise be part of the id and
    // every such request would 404.
    it('ignores the query when reading a project id', async () => {
      await expect(run(`/api/workspaces/${WS}/projects/${UUID}?expand=members`)).resolves.toBeUndefined()
      await expect(async () => run(`/api/workspaces/${WS}/projects/new?expand=members`))
        .rejects.toMatchObject({ statusCode: 404 })
    })

    it('ignores the query when reading a workspace id', async () => {
      await expect(run(`/api/workspaces/${WS}?fields=plan`)).resolves.toBeUndefined()
      await expect(async () => run('/api/workspaces/not-a-uuid?fields=plan'))
        .rejects.toMatchObject({ statusCode: 404 })
    })
  })
})
