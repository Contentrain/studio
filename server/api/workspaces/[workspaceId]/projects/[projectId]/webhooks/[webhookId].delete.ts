/**
 * Delete an outbound webhook. Hard delete — cascades to deliveries.
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

  // Use admin for mutations (RLS is SELECT-only for users)
  const admin = useSupabaseAdmin()

  // Delete deliveries first (cascade)
  await admin
    .from('webhook_deliveries')
    .delete()
    .eq('webhook_id', webhookId)

  // Delete webhook — scoped to workspace + project for ownership verification
  const { error } = await admin
    .from('webhooks')
    .delete()
    .eq('id', webhookId)
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return { deleted: true }
})
