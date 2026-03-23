/**
 * Create a new CDN API key. Returns the full key ONCE — never shown again.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<{ name: string }>(event)

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  if (!body.name?.trim())
    throw createError({ statusCode: 400, message: 'name is required' })

  // Plan check
  const client = useSupabaseUserClient(session.accessToken)
  const { data: workspace } = await client
    .from('workspaces')
    .select('plan')
    .eq('id', workspaceId)
    .single()

  const plan = getWorkspacePlan(workspace ?? {})
  if (!hasFeature(plan, 'cdn.delivery'))
    throw createError({ statusCode: 403, message: 'CDN requires Pro plan or higher' })

  // Check key limit
  const keyLimit = getPlanLimit(plan, 'cdn.api_keys')
  const { count } = await client
    .from('cdn_api_keys')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .is('revoked_at', null)

  if ((count ?? 0) >= keyLimit)
    throw createError({ statusCode: 403, message: `Plan allows max ${keyLimit} API keys` })

  // Generate key
  const { key, keyHash, keyPrefix } = generateCDNKey()

  const { data, error } = await client
    .from('cdn_api_keys')
    .insert({
      project_id: projectId,
      workspace_id: workspaceId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: body.name.trim(),
    })
    .select('id, name, key_prefix, environment, created_at')
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  // Return the FULL key — this is the only time it's shown
  return { ...data, key }
})
