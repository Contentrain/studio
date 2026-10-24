/**
 * The owner's choices in the setup of a migrated project (the setup wizard), one per call:
 *
 * - `{ skip: step }` / `{ unskip: step }`: a step the owner leaves for later (forms, comments, images, live), or takes up
 *   again. Skipping changes nothing on the site; it only stops the setup asking (`migrationSetupSteps`).
 * - `{ liveSiteUrl }`: the address of the site's live build (https), where the live-site check looks.
 * - `{ seen: true }`: the owner sees the test change on the live site (the check's manual fallback); only once the
 *   check is on its way to the site (merged, or its pull request).
 *
 * Owner/admin only. The record is merged key by key (`mergeProjectMigrationSetup`), so a click never overwrites what
 * the worker wrote.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/migration/setup
 *   → 200 { setup }   (the merged record) · { liveSiteUrl }
 *   → 400 migration.setup_invalid · migration.live_site_url_invalid · 404 project.not_found
 *   → 409 migration.live_check_not_landed
 */
import { MIGRATION_SETUP_STEPS, readMigrationSetupRecord } from '~~/server/utils/migration-setup'
import type { MigrationSetupStep } from '~~/server/utils/migration-setup'
import { liveCheckUrl } from '~~/server/utils/migration-live-check'

const isStep = (value: unknown): value is MigrationSetupStep => MIGRATION_SETUP_STEPS.includes(value as MigrationSetupStep)

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const body = await readBody<{ skip?: unknown, unskip?: unknown, liveSiteUrl?: unknown, seen?: unknown }>(event).catch(() => null)
  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  if (isStep(body?.skip) || isStep(body?.unskip)) {
    const step = (isStep(body?.skip) ? body.skip : body!.unskip) as MigrationSetupStep
    return { setup: await db.mergeProjectMigrationSetup(projectId, { [`skip_${step}`]: isStep(body?.skip) }) }
  }

  if (typeof body?.liveSiteUrl === 'string') {
    const liveSiteUrl = body.liveSiteUrl.trim()
    if (liveSiteUrl.length > 2048 || !liveCheckUrl(liveSiteUrl, 'x'))
      throw createError({ statusCode: 400, message: errorMessage('migration.live_site_url_invalid') })
    await db.updateProject(projectId, { live_site_url: liveSiteUrl }, 'id')
    return { liveSiteUrl }
  }

  if (body?.seen === true) {
    const row = await db.getProjectById(projectId, 'id, migration_setup')
    const check = readMigrationSetupRecord(row?.migration_setup).live_check
    // The owner can only see a change that can reach the site: merged, or its pull request (merged on GitHub since).
    if (!check || check.status === 'pending_review')
      throw createError({ statusCode: 409, message: errorMessage('migration.live_check_not_landed') })
    return { setup: await db.mergeProjectMigrationSetup(projectId, { live_check: { ...check, seenAt: new Date().toISOString(), seenBy: 'owner' } }) }
  }

  throw createError({ statusCode: 400, message: errorMessage('migration.setup_invalid') })
})
