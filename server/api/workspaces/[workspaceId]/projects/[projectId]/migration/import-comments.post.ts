/**
 * Land a migration's comments export into this project's comments — the
 * one-click path from the overview card. Same fidelity contract and plan gate
 * as the manual upload.
 *
 * Two places can hold the export:
 * - the Migrate grant for this workspace and repository (İP-2c): fetched when
 *   the claim was made and held until now (migration 040). It is imported
 *   first, and its payload is cleared as soon as it has landed;
 * - the stored handoff, which holds only where the export is: a URL is
 *   fetched, an inline export is re-read from the handoff file in the
 *   repository.
 *
 * Re-running is harmless: a comment already imported is skipped.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/migration/import-comments
 */

import type { CommentsExport } from '@contentrain/types'
import type { StoredMigrationHandoff } from '~~/server/utils/migration-handoff'
import { importCommentsFromHandoff } from '~~/server/utils/migration-handoff'
import { runCommentsImportChunked } from '~~/server/utils/comment-import'
import { normalizeLocaleParam } from '~~/server/utils/comment-public-context'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const ws = await db.getWorkspaceById(workspaceId, 'plan')
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(ws ?? {})
  if (!hasFeature(plan, 'comments.enabled') || !hasFeature(plan, 'comments.import'))
    throw createError({ statusCode: 403, message: errorMessage('comments.upgrade') })

  const row = await db.getProjectById(projectId, 'id, workspace_id, repo_full_name, migration_handoff')
  if (!row || (row.workspace_id && row.workspace_id !== workspaceId))
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const repoFullName = typeof row.repo_full_name === 'string' ? row.repo_full_name : ''
  const held = repoFullName ? await db.getMigrateCommentsExport(workspaceId, repoFullName, { withPayload: true }) : null
  const heldReady = held?.status === 'ready' && held.payload != null

  const handoff = (row.migration_handoff ?? null) as StoredMigrationHandoff | null
  if (!heldReady) {
    if (!handoff)
      throw createError({ statusCode: 404, message: errorMessage('migration.handoff_missing') })
    if (!handoff.comments?.export)
      throw createError({ statusCode: 404, message: errorMessage('migration.no_comments_export') })
  }

  const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const defaultLocale = normalizeLocaleParam((brain.config as { locales?: { default?: string } } | null)?.locales?.default, 'en')

  if (heldReady) {
    const report = await runCommentsImportChunked(projectId, workspaceId, held.payload as CommentsExport, defaultLocale)
    // Data minimisation: the export is not kept once its comments have landed.
    await db.markMigrateCommentsExportImported(held.grantId)
    return report
  }

  const report = await importCommentsFromHandoff(projectId, workspaceId, handoff!, defaultLocale, git)
  if (!report)
    throw createError({ statusCode: 404, message: errorMessage('migration.no_comments_export') })
  return report
})
