export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: 'Workspace ID is required' })

  const client = useSupabaseUserClient(session.accessToken)

  // Verify caller is workspace member (owner/admin gets full list)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  // Use admin client for full member list (user RLS only shows own row)
  return listWorkspaceMembers(useSupabaseAdmin(), workspaceId)
})
