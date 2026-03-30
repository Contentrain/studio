/**
 * Update a Conversation API key's configuration.
 */
interface UpdateConversationKeyBody {
  name?: string
  role?: 'viewer' | 'editor' | 'admin'
  specificModels?: boolean
  allowedModels?: string[]
  allowedTools?: string[]
  allowedLocales?: string[]
  customInstructions?: string | null
  aiModel?: string
  rateLimitPerMinute?: number
  monthlyMessageLimit?: number
}

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const keyId = getRouterParam(event, 'keyId')
  const body = await readBody<UpdateConversationKeyBody>(event)

  if (!workspaceId || !projectId || !keyId)
    throw createError({ statusCode: 400, message: errorMessage('api.key_id_required') })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  // Plan check for custom instructions
  if (body.customInstructions !== undefined) {
    const { data: workspace } = await client
      .from('workspaces')
      .select('plan')
      .eq('id', workspaceId)
      .single()

    const plan = getWorkspacePlan(workspace ?? {})
    if (!hasFeature(plan, 'api.custom_instructions') && body.customInstructions)
      throw createError({ statusCode: 403, message: errorMessage('conversation.upgrade') })
  }

  // Build update object — only include provided fields
  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name.trim()
  if (body.role !== undefined) updates.role = body.role
  if (body.specificModels !== undefined) updates.specific_models = body.specificModels
  if (body.allowedModels !== undefined) updates.allowed_models = body.allowedModels
  if (body.allowedTools !== undefined) updates.allowed_tools = body.allowedTools
  if (body.allowedLocales !== undefined) updates.allowed_locales = body.allowedLocales
  if (body.customInstructions !== undefined) updates.custom_instructions = body.customInstructions
  if (body.aiModel !== undefined) updates.ai_model = body.aiModel
  if (body.rateLimitPerMinute !== undefined) updates.rate_limit_per_minute = body.rateLimitPerMinute
  if (body.monthlyMessageLimit !== undefined) updates.monthly_message_limit = body.monthlyMessageLimit

  if (Object.keys(updates).length === 0)
    throw createError({ statusCode: 400, message: errorMessage('validation.no_fields_to_update') })

  // Verify key exists and belongs to this workspace/project
  const admin = useSupabaseAdmin()
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

  const { data, error } = await admin
    .from('conversation_api_keys')
    .update(updates)
    .eq('id', keyId)
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId)
    .select('id, name, key_prefix, role, specific_models, allowed_models, allowed_tools, allowed_locales, custom_instructions, ai_model, rate_limit_per_minute, monthly_message_limit, created_at')
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return data
})
