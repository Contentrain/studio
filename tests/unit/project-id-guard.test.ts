import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A project id goes from the URL path straight into a query against a
 * `uuid` column, so a segment that is not a uuid does not read as "not
 * found" — Postgres rejects the literal and the request 500s. That is
 * how `/api/workspaces/:id/projects/new/` behaved once the
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

describe('project id guard', () => {
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
    const handler = (await import('../../server/middleware/02b.project-id')).default as (e: unknown) => unknown
    return handler({})
  }

  const UUID = '9f0dbe16-0f8e-4a4e-9a1e-9c0f1b2c3d4e'

  // The reported path, plus the same shape on every other tree that
  // takes a project id from the URL.
  it.each([
    '/api/workspaces/ws-1/projects/new',
    '/api/workspaces/ws-1/projects/new/', // the trailing slash Sentry recorded
    '/api/workspaces/ws-1/projects/new/content',
    '/api/media/v1/new/assets',
    '/api/mcp/v1/not-a-uuid/mcp',
    '/api/comments/v1/undefined/blog/entry-1',
    '/api/forms/v1/null/contact/submit',
  ])('answers 404 for %s', async (path) => {
    await expect(async () => run(path)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('says nothing more for a malformed id than for a missing one', async () => {
    // A 400 here would separate "malformed" from "well-formed but
    // absent", which tells a prober which ids exist.
    await expect(async () => run('/api/workspaces/ws-1/projects/new'))
      .rejects.toMatchObject({ message: 'project.not_found' })
  })

  it.each([
    `/api/workspaces/ws-1/projects/${UUID}`,
    `/api/workspaces/ws-1/projects/${UUID}/content/blog`,
    `/api/workspaces/ws-1/projects/${UUID.toUpperCase()}`, // uuid case is not significant
    `/api/media/v1/${UUID}/assets`,
    `/api/mcp/v1/${UUID}/mcp`,
    `/api/comments/v1/${UUID}/blog/entry-1`,
    `/api/forms/v1/${UUID}/contact/submit`,
  ])('lets %s through', async (path) => {
    await expect(run(path)).resolves.toBeUndefined()
  })

  it.each([
    '/api/workspaces/ws-1/projects', // the collection route
    '/api/workspaces/ws-1/projects/', // and a trailing slash on it
    '/api/workspaces/ws-1', // no projects segment at all
    '/api/workspaces/ws-1/settings', // segment 5 is not a project id here
    '/api/workspaces/ws-1/billing/portal',
    '/api/mcp/remote/authorize', // OAuth surface — carries no project id
    '/api/profile',
    '/api/cdn/v1/anything', // a tree the guard does not cover
  ])('does not touch %s', async (path) => {
    await expect(run(path)).resolves.toBeUndefined()
  })

  it('ignores the query string when reading the last segment', async () => {
    // `getRequestPath` hands back the query too, and the id is often the
    // last segment — so `?expand=1` would otherwise be part of the id.
    await expect(run(`/api/workspaces/ws-1/projects/${UUID}?expand=members`)).resolves.toBeUndefined()
    await expect(async () => run('/api/workspaces/ws-1/projects/new?expand=members'))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})
