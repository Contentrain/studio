/**
 * Project id shape guard.
 *
 * Every project-scoped route takes the id straight from the path and
 * hands it to a query. `project_id` is a `uuid` column, so a segment
 * that is not a uuid does not come back empty — Postgres rejects the
 * literal and the request ends as a 500 (`invalid input syntax for type
 * uuid`). That is how `/api/workspaces/:id/projects/new/` behaved:
 * the `projects/new` page was removed in 68345ed, so the path now falls
 * through to the `[projectId]` route with `projectId = "new"`.
 *
 * Checked here rather than in each handler because there are more than
 * twenty routes under `[projectId]` alone, across five trees, and none of
 * them had the check. A guard per handler is a guard that will be missing
 * from the twenty-first.
 *
 * Runs after 01.auth (so an unauthenticated caller still gets 401 first)
 * and before 03.billing (which would otherwise read the workspace before
 * we know the path is even well-formed). The `02b` prefix keeps that
 * ordering without renaming 02.accept-invite.
 *
 * Answers 404, not 400. A 400 would say "that id is well-formed but
 * absent" for real ids and "that id is malformed" for these, which tells
 * an unauthenticated prober which project ids exist. 404 says the same
 * thing to everyone.
 */

import { isUuid } from '../../shared/utils/uuid'
import { errorMessage } from '../utils/content-strings'

/**
 * Where the project id sits in each tree, as a 0-based index into the
 * path's segments (the leading empty string from the leading slash
 * included, so `/api/media/v1/{id}` is index 4).
 *
 * Safe as a prefix match because none of these trees has a static
 * sibling of `[projectId]` — nothing legitimate can land on the index
 * and be rejected for not being a uuid. A future static route added
 * beside one of them (`/api/media/v1/health`) would need an exemption
 * here, which is the trade for one guard instead of twenty.
 */
const PROJECT_ID_ROUTES: ReadonlyArray<{ prefix: string, index: number }> = [
  { prefix: '/api/workspaces/', index: 5 }, // /api/workspaces/{ws}/projects/{id}
  { prefix: '/api/media/v1/', index: 4 },
  { prefix: '/api/mcp/v1/', index: 4 },
  { prefix: '/api/comments/v1/', index: 4 },
  { prefix: '/api/forms/v1/', index: 4 },
]

export default defineEventHandler((event) => {
  // `getRequestPath` carries the query string; the id can be the last
  // segment, so `?foo=bar` would ride along into the comparison.
  const path = getRequestPath(event).split('?')[0]!

  const route = PROJECT_ID_ROUTES.find(r => path.startsWith(r.prefix))
  if (!route) return

  const segments = path.split('/')

  // The workspaces tree only carries a project id under `/projects/`.
  // `/api/workspaces/{ws}/settings/...` has an unrelated segment 5.
  if (route.prefix === '/api/workspaces/' && segments[4] !== 'projects') return

  const projectId = segments[route.index]

  // No id segment at all — a collection route (`…/projects`) or a
  // trailing slash on one. Not this middleware's business.
  if (!projectId) return

  if (!isUuid(projectId))
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })
})
