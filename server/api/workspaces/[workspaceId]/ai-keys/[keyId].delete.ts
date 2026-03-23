/**
 * Delete a BYOA API key.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const keyId = getRouterParam(event, 'keyId')

  if (!workspaceId || !keyId)
    throw createError({ statusCode: 400, message: 'workspaceId and keyId are required' })

  const client = useSupabaseUserClient(session.accessToken)

  const { error } = await client
    .from('ai_keys')
    .delete()
    .eq('id', keyId)
    .eq('workspace_id', workspaceId)
    .eq('user_id', session.user.id)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return { deleted: true }
})
