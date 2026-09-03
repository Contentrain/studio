/**
 * Re-read `contentrain-handoff.json` from the repository and store it on the
 * project. Workspace owners/admins only.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/migration/sync
 */

import { syncMigrationHandoff } from '~~/server/utils/migration-handoff'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const { git, contentRoot, project } = await resolveProjectContext(workspaceId, projectId)
  const result = await syncMigrationHandoff({
    projectId,
    git,
    contentRoot,
    project: { repo_full_name: project.repo_full_name, default_branch: project.default_branch ?? 'main' },
  })

  return { found: result.found, summary: result.summary ?? null, source: result.source ?? null }
})
