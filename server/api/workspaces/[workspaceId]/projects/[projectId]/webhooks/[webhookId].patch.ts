/**
 * Update an outbound webhook (name, url, events, active).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const webhookId = getRouterParam(event, 'webhookId')
  const body = await readBody<{ name?: string, url?: string, events?: string[], active?: boolean }>(event)

  if (!workspaceId || !projectId || !webhookId)
    throw createError({ statusCode: 400, message: errorMessage('webhook.id_required') })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  // Plan check
  const { data: workspace } = await client
    .from('workspaces')
    .select('plan')
    .eq('id', workspaceId)
    .single()

  if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'api.webhooks_outbound'))
    throw createError({ statusCode: 403, message: errorMessage('webhook.upgrade_required') })

  // Validate URL if provided
  if (body.url !== undefined) {
    try {
      const parsed = new URL(body.url)
      if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('Invalid protocol')
    }
    catch {
      throw createError({ statusCode: 400, message: errorMessage('webhook.url_invalid') })
    }
  }

  // Build update payload — only include provided fields
  const update: Record<string, unknown> = {}
  if (body.name !== undefined) update.name = body.name.trim()
  if (body.url !== undefined) update.url = body.url.trim()
  if (body.events !== undefined) update.events = body.events
  if (body.active !== undefined) update.active = body.active
  update.updated_at = new Date().toISOString()

  if (Object.keys(update).length <= 1)
    throw createError({ statusCode: 400, message: errorMessage('validation.no_fields_to_update') })

  const { data, error } = await client
    .from('webhooks')
    .update(update)
    .eq('id', webhookId)
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)
    .select('id, name, url, events, active, created_at, updated_at')
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  if (!data)
    throw createError({ statusCode: 404, message: errorMessage('webhook.not_found') })

  return data
})
