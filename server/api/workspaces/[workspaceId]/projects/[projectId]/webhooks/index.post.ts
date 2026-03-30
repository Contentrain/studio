/**
 * Create a new outbound webhook. Returns the full secret ONCE — never shown again.
 */
import { randomBytes } from 'node:crypto'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<{ name: string, url: string, events: string[] }>(event)

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  if (!body.name?.trim())
    throw createError({ statusCode: 400, message: errorMessage('webhook.name_required') })

  if (!body.url?.trim())
    throw createError({ statusCode: 400, message: errorMessage('webhook.url_required') })

  if (!body.events?.length)
    throw createError({ statusCode: 400, message: errorMessage('webhook.events_required') })

  // Validate URL format + SSRF protection
  if (!isAllowedWebhookUrl(body.url))
    throw createError({ statusCode: 400, message: errorMessage('webhook.url_required') })

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
  if (!hasFeature(plan, 'api.webhooks_outbound'))
    throw createError({ statusCode: 403, message: errorMessage('webhook.upgrade_required') })

  // Check webhook limit
  const webhookLimit = getPlanLimit(plan, 'api.webhooks')
  const { count } = await client
    .from('webhooks')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)

  if ((count ?? 0) >= webhookLimit)
    throw createError({ statusCode: 403, message: errorMessage('webhook.limit_reached', { limit: webhookLimit }) })

  // Generate secret
  const secret = randomBytes(32).toString('hex')

  // Use admin client for INSERT (RLS has SELECT-only for users)
  const admin = useSupabaseAdmin()
  const { data, error } = await admin
    .from('webhooks')
    .insert({
      project_id: projectId,
      workspace_id: workspaceId,
      name: body.name.trim(),
      url: body.url.trim(),
      events: body.events,
      secret,
      active: true,
    })
    .select('id, name, url, events, active, created_at')
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  // Return the FULL secret — this is the only time it's shown
  return { ...data, secret }
})
