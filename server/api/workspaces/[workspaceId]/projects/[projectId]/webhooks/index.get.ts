/**
 * List outbound webhooks for a project.
 * Secrets are masked — only the last 4 characters are shown.
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

  // Plan check
  const { data: workspace } = await client
    .from('workspaces')
    .select('plan')
    .eq('id', workspaceId)
    .single()

  if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'api.webhooks_outbound'))
    throw createError({ statusCode: 403, message: errorMessage('webhook.upgrade_required') })

  const { data } = await client
    .from('webhooks')
    .select('id, name, url, events, active, created_at, updated_at, secret')
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })

  // Mask secrets — show only last 4 chars
  const webhooks = (data ?? []).map((w: { secret: string, [key: string]: unknown }) => ({
    ...w,
    secret: w.secret ? `****${w.secret.slice(-4)}` : null,
  }))

  return webhooks
})
