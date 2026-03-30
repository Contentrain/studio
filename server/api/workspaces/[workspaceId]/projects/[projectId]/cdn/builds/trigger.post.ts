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

  const client = db.getUserClient(session.accessToken)
  const admin = db.getAdminClient()

  // Verify owner/admin
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  // Plan check
  const { data: workspace } = await client
    .from('workspaces')
    .select('plan')
    .eq('id', workspaceId)
    .single()

  if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'cdn.delivery'))
    throw createError({ statusCode: 403, message: errorMessage('cdn.upgrade') })

  // Get project
  const { git, contentRoot } = await resolveProjectContext(client, workspaceId, projectId)

  const { data: project } = await client
    .from('projects')
    .select('cdn_enabled, cdn_branch, default_branch')
    .eq('id', projectId)
    .single()

  if (!project?.cdn_enabled)
    throw createError({ statusCode: 400, message: errorMessage('cdn.not_enabled') })

  const cdn = useCDNProvider()
  if (!cdn)
    throw createError({ statusCode: 503, message: errorMessage('cdn.storage_not_configured') })

  const branch = project.cdn_branch ?? project.default_branch ?? 'main'

  // Get latest commit SHA
  let commitSha = 'manual'
  try {
    const branches = await git.listBranches()
    const target = branches.find(b => b.name === branch)
    if (target) commitSha = target.sha
  }
  catch { /* use 'manual' */ }

  // Create build record
  const { data: build, error: buildError } = await admin
    .from('cdn_builds')
    .insert({
      project_id: projectId,
      trigger_type: 'manual',
      commit_sha: commitSha,
      branch,
      status: 'building',
    })
    .select('id')
    .single()

  if (buildError || !build)
    throw createError({ statusCode: 500, message: errorMessage('cdn.build_failed', { detail: buildError?.message ?? 'unknown' }) })

  // SSE stream for progress
  const eventStream = createEventStream(event)

  const processBuild = async () => {
    try {
      const result = await executeCDNBuild({
        projectId,
        buildId: build.id,
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
      await admin
        .from('cdn_builds')
        .update({
          status: result.error ? 'failed' : 'success',
          file_count: result.filesUploaded,
          total_size_bytes: result.totalSizeBytes,
          changed_models: result.changedModels,
          build_duration_ms: result.durationMs,
          error_message: result.error ?? null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', build.id)

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
      await admin.from('cdn_builds').update({
        status: 'failed',
        error_message: msg,
        completed_at: new Date().toISOString(),
      }).eq('id', build.id)
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
