export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const client = useSupabaseUserClient(session.accessToken)

  // Verify membership first (user client respects RLS on workspace_members)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  // Use admin client for the actual read — RLS on workspaces only allows owner_id = auth.uid()
  const admin = useSupabaseAdmin()
  const { data, error } = await admin
    .from('workspaces')
    .select(`
      *,
      workspace_members(
        id, role, user_id, invited_email, accepted_at,
        profiles:user_id(id, display_name, email, avatar_url)
      )
    `)
    .eq('id', workspaceId)
    .single()

  if (error)
    throw createError({ statusCode: error.code === 'PGRST116' ? 404 : 500, message: error.message })

  return data
})
