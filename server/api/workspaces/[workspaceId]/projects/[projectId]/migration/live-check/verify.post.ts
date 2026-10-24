/**
 * Look for the setup's test change on the live site: the last check's nonce at `<liveSiteUrl>/.well-known/
 * contentrain-check.txt`, fetched through the guarded fetch (`liveSiteShowsCheck`: https, public addresses only, the
 * site's own host, a short deadline). Seen: the live-site step is done. Not seen yet is an answer, not an error: the
 * host may still be building.
 *
 * Owner/admin only (a server-side fetch on their address).
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/migration/live-check/verify
 *   → 200 { seen: boolean, seenAt? }
 *   → 404 project.not_found · 409 migration.live_check_not_landed · migration.live_site_url_invalid · 429
 */
import { readMigrationSetupRecord } from '~~/server/utils/migration-setup'
import { liveSiteShowsCheck } from '~~/server/utils/migration-live-check'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const row = await db.getProjectById(projectId, 'id, migration_setup, live_site_url')
  const check = readMigrationSetupRecord(row?.migration_setup).live_check
  if (!check || check.status === 'pending_review')
    throw createError({ statusCode: 409, message: errorMessage('migration.live_check_not_landed') })
  if (check.seenAt) return { seen: true, seenAt: check.seenAt }
  const liveSiteUrl = typeof row?.live_site_url === 'string' ? row.live_site_url : ''
  if (!liveSiteUrl)
    throw createError({ statusCode: 409, message: errorMessage('migration.live_site_url_invalid') })

  const rate = await checkRateLimit(`migration-live-verify:${session.user.id}`, 10, 60_000)
  if (!rate.allowed)
    throw createError({ statusCode: 429, message: errorMessage('migration.setup_rate_limited') })

  if (!await liveSiteShowsCheck(liveSiteUrl, check.nonce)) return { seen: false }
  const seenAt = new Date().toISOString()
  await db.mergeProjectMigrationSetup(projectId, { live_check: { ...check, seenAt, seenBy: 'fetch' } })
  return { seen: true, seenAt }
})
