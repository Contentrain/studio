/**
 * List recent CDN builds for a project.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  const client = useSupabaseUserClient(session.accessToken)

  const { data } = await client
    .from('cdn_builds')
    .select('id, trigger_type, commit_sha, branch, status, file_count, total_size_bytes, changed_models, build_duration_ms, error_message, started_at, completed_at')
    .eq('project_id', projectId)
    .order('started_at', { ascending: false })
    .limit(20)

  return data ?? []
})
