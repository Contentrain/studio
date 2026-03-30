/**
 * List Conversation API keys for a project (hashes hidden, prefixes shown).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const client = useSupabaseUserClient(session.accessToken)

  // Defense in depth: explicit role check (RLS also filters)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  const admin = useSupabaseAdmin()
  const { data } = await admin
    .from('conversation_api_keys')
    .select('id, name, key_prefix, role, specific_models, allowed_models, allowed_tools, allowed_locales, custom_instructions, ai_model, rate_limit_per_minute, monthly_message_limit, last_used_at, created_at, revoked_at')
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })

  // Get usage stats for each active key
  const month = new Date().toISOString().substring(0, 7)
  const keyIds = (data ?? []).filter(k => !k.revoked_at).map(k => k.id)

  let usageMap: Record<string, number> = {}
  if (keyIds.length > 0) {
    const { data: usageRows } = await admin
      .from('agent_usage')
      .select('api_key_id, message_count')
      .in('api_key_id', keyIds)
      .eq('month', month)
      .eq('source', 'api')

    usageMap = Object.fromEntries(
      (usageRows ?? []).map(r => [r.api_key_id, r.message_count ?? 0]),
    )
  }

  return (data ?? []).map(key => ({
    id: key.id,
    name: key.name,
    keyPrefix: key.key_prefix,
    role: key.role,
    specificModels: key.specific_models,
    allowedModels: key.allowed_models,
    allowedTools: key.allowed_tools,
    allowedLocales: key.allowed_locales,
    customInstructions: key.custom_instructions,
    aiModel: key.ai_model,
    rateLimitPerMinute: key.rate_limit_per_minute,
    monthlyMessageLimit: key.monthly_message_limit,
    monthlyUsage: usageMap[key.id] ?? 0,
    lastUsedAt: key.last_used_at,
    createdAt: key.created_at,
    revokedAt: key.revoked_at,
  }))
})
