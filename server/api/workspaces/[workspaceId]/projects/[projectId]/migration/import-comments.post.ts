/**
 * Land the comments export referenced by the stored handoff (inline or by
 * URL) into this project's comments — the one-click path from the overview
 * card. Same fidelity contract and plan gate as the manual upload.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/migration/import-comments
 */

import type { MigrationHandoff } from '@contentrain/types'
import { importCommentsFromHandoff } from '~~/server/utils/migration-handoff'
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

  const row = await db.getProjectById(projectId, 'id, workspace_id, migration_handoff')
  const handoff = (row?.migration_handoff ?? null) as MigrationHandoff | null
  if (!handoff)
    throw createError({ statusCode: 404, message: errorMessage('migration.handoff_missing') })
  if (!handoff.comments?.export)
    throw createError({ statusCode: 404, message: errorMessage('migration.no_comments_export') })

  const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const defaultLocale = normalizeLocaleParam((brain.config as { locales?: { default?: string } } | null)?.locales?.default, 'en')
  const report = await importCommentsFromHandoff(projectId, workspaceId, handoff, defaultLocale)
  if (!report)
    throw createError({ statusCode: 404, message: errorMessage('migration.no_comments_export') })
  return report
})
