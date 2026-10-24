/**
 * Approve the media move held for review (the setup's images step): the `cr/media/*` branch the apply left on a review
 * project — the owner's own Move (the setup record's `media_apply`) or a bundle grant's import (the grant's media
 * record) — merged under this click, as the apply's own click merges it (`mergeOnClick`: recorded with the clicker's
 * role and the note, re-asked against the branch tip, merged with a receipt). A policy that wants more than this one
 * grant keeps it for its reviewers.
 *
 * A write that landed since the apply makes the merge a conflict, never an overwrite: the held branch is removed and
 * the step asks for the move again (it is rewritten from the current content).
 *
 * Owner/admin only.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/migration/media/approve
 *   → 200 { status: 'merged' | 'pull_request' | 'pending_review', branch, pullRequestUrl }
 *   → 404 project.not_found · migration.media_not_held · 409 migration.media_apply_conflict
 */
import { invalidateBrainCache, getOrBuildBrainCache } from '~~/server/utils/brain-cache'
import { mergeOnClick } from '~~/server/utils/click-approval'
import { createContentEngine } from '~~/server/utils/content-engine'
import { readMigrationSetupRecord } from '~~/server/utils/migration-setup'
import { MEDIA_APPLY_APPROVAL_NOTE } from '~~/server/utils/migration-media-write'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id, repo_full_name, migration_setup')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })
  if (!session.user.email)
    throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })

  // The held branch of the latest import: the owner's apply first, then the grant's.
  const job = await db.getLatestMigrationMediaJob(projectId)
  const jobId = job ? String(job.id) : null
  const applied = readMigrationSetupRecord(project.migration_setup).media_apply
  const grant = typeof project.repo_full_name === 'string' ? await db.getMigrateGrantForProject(workspaceId, project.repo_full_name) : null
  const grantDetail = (grant?.media_detail as Record<string, unknown> | null) ?? {}
  let held: unknown = null
  if (applied?.jobId === jobId && applied?.status === 'pending_review') held = applied.branch
  // The grant's record only when it is about this job (an older job's held branch is not this move).
  else if (grant?.media_state === 'review' && !grantDetail.pullRequestUrl && grantDetail.jobId === jobId) held = grantDetail.branch
  const ctx = await resolveProjectContext(workspaceId, projectId)
  const branch = typeof held === 'string' && held.startsWith('cr/media/') ? held : null
  if (!jobId || !branch || await ctx.git.isMerged(branch).catch(() => true))
    throw createError({ statusCode: 404, message: errorMessage('migration.media_not_held') })

  const ws = await db.getWorkspaceById(workspaceId, 'plan')
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(ws ?? {})
  const engine = createContentEngine({ git: ctx.git, contentRoot: ctx.contentRoot, projectId })
  const brain = await getOrBuildBrainCache(ctx.git, ctx.contentRoot, projectId)
  const record = (mediaApply: Record<string, unknown>) =>
    db.mergeProjectMigrationSetup(projectId, { media_apply: { jobId, ...mediaApply, at: new Date().toISOString() } })

  let landed: Awaited<ReturnType<typeof mergeOnClick>>
  try {
    landed = await mergeOnClick({
      db,
      git: ctx.git,
      contentRoot: ctx.contentRoot,
      projectId,
      plan,
      branch,
      brain,
      engine,
      approver: { id: session.user.id, email: session.user.email, role: role ?? null, workspaceId },
      note: MEDIA_APPLY_APPROVAL_NOTE,
    })
  }
  catch (error) {
    const status = error as { status?: number, statusCode?: number }
    if (status.status !== 409 && status.statusCode !== 409) throw error
    landed = { held: false, merge: { merged: false, sha: null, pullRequestUrl: null, conflict: true } }
  }
  if (landed.held) {
    await record({ status: 'pending_review', branch, pullRequestUrl: null })
    return { status: 'pending_review', branch, pullRequestUrl: null }
  }
  const merge = landed.merge
  if (merge.conflict || (!merge.merged && !merge.pullRequestUrl)) {
    await ctx.git.deleteBranch(branch).catch(() => {})
    await record({ status: 'failed', code: 'conflict', branch: null })
    throw createError({ statusCode: 409, message: errorMessage('migration.media_apply_conflict') })
  }
  invalidateBrainCache(projectId)
  const status = merge.pullRequestUrl ? 'pull_request' : 'merged'
  await record({ status, branch, pullRequestUrl: merge.pullRequestUrl ?? null })
  return { status, branch, pullRequestUrl: merge.pullRequestUrl ?? null }
})
