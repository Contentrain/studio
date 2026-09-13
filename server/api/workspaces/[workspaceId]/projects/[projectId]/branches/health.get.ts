/**
 * Branch health for a project: how many `cr/*` branches are pending, and where
 * the content branch stands against the repository's own.
 *
 * The two are cached separately and on purpose. The branch count moves slowly
 * (six hours is fine); the sync state moves on every merge and every push by
 * anyone, and a stale "in sync" is the reading that costs someone an
 * afternoon — see `content-sync.ts`.
 */

import { readContentSync } from '~~/server/utils/content-sync'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  await requireProjectAccess(session.user.id, workspaceId, projectId, session.accessToken)

  const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)
  const sync = await readContentSync(git, projectId).catch(() => null)

  const cached = await getHealthStatus(projectId)
  if (cached) return { ...cached, sync }

  return { ...(await checkBranchHealth(git, projectId, contentRoot)), sync }
})
