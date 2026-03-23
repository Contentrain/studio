/**
 * Manually trigger a CDN rebuild.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  const client = useSupabaseUserClient(session.accessToken)
  const admin = useSupabaseAdmin()

  // Verify owner/admin
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  // Plan check
  const { data: workspace } = await client
    .from('workspaces')
    .select('plan')
    .eq('id', workspaceId)
    .single()

  if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'cdn.delivery'))
    throw createError({ statusCode: 403, message: 'CDN requires Pro plan or higher' })

  // Get project
  const { git, contentRoot } = await resolveProjectContext(client, workspaceId, projectId)

  const { data: project } = await client
    .from('projects')
    .select('cdn_enabled, cdn_branch, default_branch')
    .eq('id', projectId)
    .single()

  if (!project?.cdn_enabled)
    throw createError({ statusCode: 400, message: 'CDN is not enabled for this project' })

  const cdn = useCDNProvider()
  if (!cdn)
    throw createError({ statusCode: 503, message: 'CDN storage not configured' })

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
  const { data: build } = await admin
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

  if (!build)
    throw createError({ statusCode: 500, message: 'Failed to create build record' })

  // Execute build (async — don't block response)
  executeCDNBuild({
    projectId,
    buildId: build.id,
    git,
    cdn,
    contentRoot,
    commitSha,
    branch,
    fullRebuild: true,
  }).then(async (result) => {
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
  })

  return { buildId: build.id, status: 'building' }
})
