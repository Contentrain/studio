/**
 * Move a project's media references to this instance (#321) — see
 * `server/utils/media-rehost.ts`.
 *
 * Owner/admin only. `dryRun` reports what would change (files, references,
 * distinct media paths, and the paths this project's storage does not hold).
 * A real run commits once; with any asset still missing it commits nothing
 * and answers 409 with the list. `copyAssets` also needs owner/admin on the
 * source project's workspace — a project id alone must never be enough to
 * read another tenant's files.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/media/rehost
 * body { from: { siteUrl, projectId }, dryRun?, copyAssets? }
 */

import { checkRehostSource, runMediaRehost } from '~~/server/utils/media-rehost'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (permissions.workspaceRole !== 'owner' && permissions.workspaceRole !== 'admin')
    throw createError({ statusCode: 403, message: errorMessage('project.settings_owner_only') })

  const body = await readBody<{ from?: { siteUrl?: unknown, projectId?: unknown }, dryRun?: unknown, copyAssets?: unknown }>(event)
  const from = {
    siteUrl: typeof body?.from?.siteUrl === 'string' ? body.from.siteUrl : '',
    projectId: typeof body?.from?.projectId === 'string' ? body.from.projectId.trim() : '',
  }
  // A real run must be asked for explicitly.
  const dryRun = body?.dryRun !== false
  const copyAssets = body?.copyAssets === true
  const siteUrl = String(useRuntimeConfig().public.siteUrl ?? '')

  const sourceError = checkRehostSource({ from, projectId, siteUrl, copyAssets })
  if (sourceError)
    throw createError({ statusCode: 400, message: errorMessage(`media.rehost_${sourceError}`) })

  // Project ids are public (they are in every delivery URL). Before anything
  // reads the source's storage or library — dry run included — the caller
  // must be owner/admin of the source's workspace. Neither refusal carries a
  // count or anything else about the source.
  if (copyAssets) {
    const db = useDatabaseProvider()
    const source = await db.getProjectById(from.projectId, 'id, workspace_id')
    if (!source)
      throw createError({ statusCode: 404, message: errorMessage('project.not_found') })
    try {
      await db.requireWorkspaceRole(session.accessToken, session.user.id, source.workspace_id as string, ['owner', 'admin'])
    }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 403) throw error
      throw createError({ statusCode: 403, message: errorMessage('media.rehost_copy_source_forbidden') })
    }
  }

  const cdn = useCDNProvider()
  if (!cdn)
    throw createError({ statusCode: 503, message: errorMessage('cdn.storage_not_configured') })

  const rate = await checkRateLimit(`media-rehost:${session.user.id}`, 10, 60_000)
  if (!rate.allowed)
    throw createError({ statusCode: 429, message: errorMessage('rate.limit_exceeded') })

  const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)
  const engine = createContentEngine({ git, contentRoot, projectId })
  await engine.ensureContentBranch()

  const result = await runMediaRehost({
    git,
    cdn,
    contentRoot,
    projectId,
    siteUrl,
    from,
    dryRun,
    copyAssets,
    library: useDatabaseProvider(),
    workspaceId,
    userEmail: session.user.email ?? '',
    merge: branch => engine.mergeBranch(branch),
  })

  if (result.status === 'missing_assets')
    throw createError({ statusCode: 409, message: errorMessage('media.rehost_missing_assets', { count: result.counts.missing.length }), data: result.counts })
  if (result.status === 'copy_failed')
    throw createError({ statusCode: 409, message: errorMessage('media.rehost_copy_failed', { count: result.counts.copy.failed.length }), data: result.counts })
  if (result.status === 'library_failed')
    throw createError({ statusCode: 409, message: errorMessage('media.rehost_library_failed'), data: result.counts })
  if (result.status === 'conflict')
    throw createError({ statusCode: 409, message: errorMessage('media.rehost_conflict'), data: result.counts })

  if (result.status === 'committed') invalidateBrainCache(projectId)
  return result
})
