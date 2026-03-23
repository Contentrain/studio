/**
 * Revoke a CDN API key (soft delete — sets revoked_at).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const keyId = getRouterParam(event, 'keyId')

  if (!workspaceId || !keyId)
    throw createError({ statusCode: 400, message: 'workspaceId and keyId are required' })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  const { error } = await client
    .from('cdn_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('workspace_id', workspaceId)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return { revoked: true }
})
