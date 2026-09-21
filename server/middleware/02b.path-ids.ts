/**
 * Path id shape guard.
 *
 * Workspace and project ids go from the URL straight into queries against
 * `uuid` columns. A segment that is not a uuid therefore does not read as
 * "not found" — Postgres rejects the literal and the request ends as a
 * 500 (`invalid input syntax for type uuid`). That is how
 * `/api/workspaces/:id/projects/new/` behaved: the `projects/new` page was
 * removed in 68345ed when connecting a repository became a dialog, so the
 * path now falls through to the `[projectId]` route with
 * `projectId = "new"`.
 *
 * Checked here rather than in each handler because there are more than
 * twenty routes under `[projectId]` alone, across five trees, and none of
 * them had the check. A guard per handler is a guard that will be missing
 * from the twenty-first.
 *
 * Runs after 01.auth (so an unauthenticated caller still gets 401 first)
 * and before 03.billing (which reads the workspace by the very id this
 * guards, and would otherwise be the thing that 500s). The `02b` prefix
 * buys that ordering without renaming 02.accept-invite.
 *
 * Answers 404, not 400. A 400 would separate "malformed" from
 * "well-formed but absent", which on the public trees hands an
 * unauthenticated caller an existence oracle. 404 says the same thing to
 * everyone.
 *
 * Scope is the path only. `/api/billing/*` takes its `workspaceId` from
 * the request body, which this cannot see and does not try to.
 */

import { isUuid } from '../../shared/utils/uuid'
import { errorMessage } from '../utils/content-strings'

/**
 * Where an id sits in each tree, as a 0-based index into the path's
 * segments — the leading empty string from the leading slash included, so
 * `/api/media/v1/{id}` is index 4.
 *
 * `after` pins a literal that must sit in front of the id, which is what
 * keeps `/api/workspaces/{ws}/settings` from being read as a project id.
 *
 * Safe as a prefix match because no tree here has a static sibling of its
 * id segment — nothing legitimate can land on one of these indexes and be
 * rejected for not being a uuid. A static route added beside one later
 * (`/api/media/v1/health`) would need an exemption, and that is the trade
 * for one guard instead of twenty.
 */
const UUID_PATH_SEGMENTS: ReadonlyArray<{
  prefix: string
  index: number
  after?: { index: number, value: string }
  key: string
}> = [
  // /api/workspaces/{workspaceId}
  { prefix: '/api/workspaces/', index: 3, key: 'workspace' },
  // /api/workspaces/{workspaceId}/projects/{projectId}
  { prefix: '/api/workspaces/', index: 5, after: { index: 4, value: 'projects' }, key: 'project' },
  // /api/{tree}/v1/{projectId}
  { prefix: '/api/media/v1/', index: 4, key: 'project' },
  { prefix: '/api/mcp/v1/', index: 4, key: 'project' },
  { prefix: '/api/comments/v1/', index: 4, key: 'project' },
  { prefix: '/api/forms/v1/', index: 4, key: 'project' },
]

export default defineEventHandler((event) => {
  // `getRequestPath` carries the query string, and an id is often the last
  // segment — without this, `?expand=members` is read as part of the id
  // and every such request 404s.
  const path = getRequestPath(event).split('?')[0]!
  if (!path.startsWith('/api/')) return

  const segments = path.split('/')

  for (const rule of UUID_PATH_SEGMENTS) {
    if (!path.startsWith(rule.prefix)) continue
    if (rule.after && segments[rule.after.index] !== rule.after.value) continue

    const value = segments[rule.index]

    // No segment there at all — a collection route (`…/projects`) or a
    // trailing slash on one. Not this middleware's business.
    if (!value) continue

    if (!isUuid(value)) {
      throw createError({
        statusCode: 404,
        message: errorMessage(rule.key === 'workspace' ? 'workspace.not_found' : 'project.not_found'),
      })
    }
  }
})
