/**
 * Get user's BYOA API keys for a workspace (hints only, never plaintext).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const client = useSupabaseUserClient(session.accessToken)

  const { data } = await client
    .from('ai_keys')
    .select('id, provider, key_hint, created_at')
    .eq('workspace_id', workspaceId)
    .eq('user_id', session.user.id)

  return data ?? []
})
