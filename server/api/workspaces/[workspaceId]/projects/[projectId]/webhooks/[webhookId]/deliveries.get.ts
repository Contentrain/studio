/**
 * List delivery history for a webhook.
 * Paginated, newest first.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const webhookId = getRouterParam(event, 'webhookId')

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

  // Verify webhook belongs to this project + workspace
  const { data: webhook } = await client
    .from('webhooks')
    .select('id')
    .eq('id', webhookId)
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!webhook)
    throw createError({ statusCode: 404, message: errorMessage('webhook.not_found') })

  // Pagination
  const query = getQuery(event)
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(Number(query.limit) || 50, 100)
  const offset = (page - 1) * limit

  const { data, count, error } = await client
    .from('webhook_deliveries')
    .select('id, event, status, response_code, response_body, retry_count, delivered_at, next_retry_at, created_at', { count: 'exact' })
    .eq('webhook_id', webhookId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return {
    deliveries: data ?? [],
    total: count ?? 0,
    page,
    limit,
  }
})
