/**
 * Save a BYOA API key (encrypted).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<{ provider: string, apiKey: string }>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: 'workspaceId is required' })

  if (!body.provider || !body.apiKey)
    throw createError({ statusCode: 400, message: 'provider and apiKey are required' })

  if (!['anthropic'].includes(body.provider))
    throw createError({ statusCode: 400, message: 'Unsupported provider' })

  // Feature gate: BYOA requires pro+
  const client = useSupabaseUserClient(session.accessToken)
  const { data: workspace } = await client
    .from('workspaces')
    .select('plan')
    .eq('id', workspaceId)
    .single()

  if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'ai.byoa'))
    throw createError({ statusCode: 403, message: 'BYOA API keys require Pro plan or above' })

  const runtimeConfig = useRuntimeConfig()
  const encryptedKey = encryptApiKey(body.apiKey, runtimeConfig.sessionSecret)
  const keyHint = getKeyHint(body.apiKey)

  const { data, error } = await client
    .from('ai_keys')
    .upsert({
      workspace_id: workspaceId,
      user_id: session.user.id,
      provider: body.provider,
      encrypted_key: encryptedKey,
      key_hint: keyHint,
    }, { onConflict: 'workspace_id,user_id,provider' })
    .select('id, provider, key_hint, created_at')
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return data
})
