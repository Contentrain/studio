/**
 * Manually trigger a CDN rebuild with SSE progress streaming.
 */
import { createEventStream } from 'h3'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  // Verify owner/admin
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  // Plan check
  const workspace = await db.getWorkspaceById(workspaceId, 'plan')

  const plan = getWorkspacePlan(workspace ?? {})
  if (!hasFeature(plan, 'cdn.delivery'))
    throw createError({ statusCode: 403, message: errorMessage('cdn.upgrade', getUpgradeParams(plan)) })

  // Get project
  const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)

  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'cdn_enabled, cdn_branch, default_branch')

  if (!project?.cdn_enabled)
    throw createError({ statusCode: 400, message: errorMessage('cdn.not_enabled') })

  const cdn = useCDNProvider()
  if (!cdn)
    throw createError({ statusCode: 503, message: errorMessage('cdn.storage_not_configured') })

  const branch = (project.cdn_branch ?? project.default_branch ?? 'main') as string

  // Get latest commit SHA
  let commitSha = 'manual'
  try {
    const branches = await git.listBranches()
    const target = branches.find(b => b.name === branch)
    if (target) commitSha = target.sha
  }
  catch { /* use 'manual' */ }

  // Create build record
  const build = await db.createCDNBuild({
    projectId,
    triggerType: 'manual',
    commitSha,
    branch,
  })

  if (!build?.id)
    throw createError({ statusCode: 500, message: errorMessage('cdn.build_failed', { detail: 'unknown' }) })

  // SSE stream for progress
  const eventStream = createEventStream(event)

  const processBuild = async () => {
    try {
      const result = await executeCDNBuild({
        projectId,
        buildId: build.id as string,
        git,
        cdn,
        contentRoot,
        commitSha,
        branch,
        fullRebuild: true,
        onProgress: (progressEvent) => {
          eventStream.push(JSON.stringify(progressEvent))
        },
      })

      // Update build record
      await db.updateCDNBuild(build.id as string, {
        status: result.error ? 'failed' : 'success',
        file_count: result.filesUploaded,
        total_size_bytes: result.totalSizeBytes,
        changed_models: result.changedModels,
        build_duration_ms: result.durationMs,
        error_message: result.error ?? null,
        completed_at: new Date().toISOString(),
      })

      await eventStream.push(JSON.stringify({
        phase: 'complete',
        message: result.error ? `Build failed: ${result.error}` : `Build complete — ${result.filesUploaded} files in ${result.durationMs}ms`,
        result: {
          buildId: build.id,
          filesUploaded: result.filesUploaded,
          totalSizeBytes: result.totalSizeBytes,
          durationMs: result.durationMs,
          error: result.error,
        },
      }))
    }
    catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Build failed'
      // Mark build as failed so it doesn't stay stuck in 'building'
      await db.updateCDNBuild(build.id as string, {
        status: 'failed',
        error_message: msg,
        completed_at: new Date().toISOString(),
      })
      try {
        await eventStream.push(JSON.stringify({ phase: 'error', message: msg }))
      }
      catch { /* stream closed */ }
    }
    finally {
      try {
        await eventStream.close()
      }
      catch { /* already closed */ }
    }
  }

  processBuild()
  eventStream.onClosed(() => { /* client disconnected */ })
  return eventStream.send()
})
