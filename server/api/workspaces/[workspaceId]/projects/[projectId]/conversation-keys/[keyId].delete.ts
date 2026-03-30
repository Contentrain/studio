/**
 * Revoke a Conversation API key (soft delete — sets revoked_at).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const keyId = getRouterParam(event, 'keyId')

  if (!workspaceId || !projectId || !keyId)
    throw createError({ statusCode: 400, message: errorMessage('api.key_id_required') })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  const admin = useSupabaseAdmin()

  // Verify key belongs to this workspace/project
  const { data: existing } = await admin
    .from('conversation_api_keys')
    .select('id')
    .eq('id', keyId)
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId)
    .is('revoked_at', null)
    .single()

  if (!existing)
    throw createError({ statusCode: 404, message: errorMessage('conversation.key_not_found') })

  const { error } = await admin
    .from('conversation_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return { revoked: true }
})
