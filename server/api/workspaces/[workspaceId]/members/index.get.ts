export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const client = useSupabaseUserClient(session.accessToken)

  // Only owner/admin can see full member roster (prevents email exposure to regular members)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  // Admin client for complete list
  return listWorkspaceMembers(useSupabaseAdmin(), workspaceId)
})
