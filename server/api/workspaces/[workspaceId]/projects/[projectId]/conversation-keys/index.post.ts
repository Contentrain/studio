/**
 * Create a new Conversation API key. Returns the full key ONCE — never shown again.
 */
interface CreateConversationKeyBody {
  name: string
  role?: 'viewer' | 'editor' | 'admin'
  specificModels?: boolean
  allowedModels?: string[]
  allowedTools?: string[]
  allowedLocales?: string[]
  customInstructions?: string
  aiModel?: string
  rateLimitPerMinute?: number
  monthlyMessageLimit?: number
}

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<CreateConversationKeyBody>(event)

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  if (!body.name?.trim())
    throw createError({ statusCode: 400, message: errorMessage('conversation.key_name_required') })

  // Role + plan check
  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  const { data: project } = await client
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const { data: workspace } = await client
    .from('workspaces')
    .select('plan')
    .eq('id', workspaceId)
    .single()

  const plan = getWorkspacePlan(workspace ?? {})
  if (!hasFeature(plan, 'api.conversation'))
    throw createError({ statusCode: 403, message: errorMessage('conversation.upgrade') })

  // Check key limit
  const keyLimit = getPlanLimit(plan, 'api.conversation_keys')
  const admin = useSupabaseAdmin()
  const { count } = await admin
    .from('conversation_api_keys')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)
    .is('revoked_at', null)

  if ((count ?? 0) >= keyLimit)
    throw createError({ statusCode: 403, message: errorMessage('conversation.key_limit') })

  // Generate key
  const { key, keyHash, keyPrefix } = generateConversationKey()

  const { data, error } = await admin
    .from('conversation_api_keys')
    .insert({
      project_id: projectId,
      workspace_id: workspaceId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: body.name.trim(),
      role: body.role ?? 'editor',
      specific_models: body.specificModels ?? false,
      allowed_models: body.allowedModels ?? [],
      allowed_tools: body.allowedTools ?? [],
      allowed_locales: body.allowedLocales ?? [],
      custom_instructions: body.customInstructions ?? null,
      ai_model: body.aiModel ?? 'claude-sonnet-4-5',
      rate_limit_per_minute: body.rateLimitPerMinute ?? 10,
      monthly_message_limit: body.monthlyMessageLimit ?? 1000,
    })
    .select('id, name, key_prefix, role, specific_models, allowed_models, allowed_tools, allowed_locales, custom_instructions, ai_model, rate_limit_per_minute, monthly_message_limit, created_at')
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  // Return the FULL key — this is the only time it's shown
  return { ...data, key }
})
