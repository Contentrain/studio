/**
 * List CDN API keys for a project (hashes hidden, prefixes shown).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  const client = useSupabaseUserClient(session.accessToken)

  // Defense in depth: explicit role check (RLS also filters)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  const { data } = await client
    .from('cdn_api_keys')
    .select('id, name, key_prefix, environment, rate_limit_per_hour, last_used_at, expires_at, created_at, revoked_at')
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })

  return data ?? []
})
