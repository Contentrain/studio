/**
 * GitHub App installation callback.
 *
 * After user installs the GitHub App on their org/account,
 * GitHub redirects here with installation_id.
 * We save it to the workspace and redirect to the dashboard.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const query = getQuery(event) as {
    installation_id?: string
    setup_action?: string
    state?: string // workspace ID passed during GitHub App install
  }

  if (!query.installation_id) {
    throw createError({ statusCode: 400, message: errorMessage('github.installation_id_missing') })
  }

  const installationId = Number(query.installation_id)
  if (!installationId || Number.isNaN(installationId))
    throw createError({ statusCode: 400, message: errorMessage('github.installation_id_invalid') })

  let workspace: { id: string, slug: string, github_installation_id: number | null } | null = null

  // If state contains workspace ID, use that (prevents binding to wrong workspace)
  if (query.state) {
    const client = useSupabaseUserClient(session.accessToken)
    // Verify user is owner/admin of target workspace
    await requireWorkspaceRole(client, session.user.id, query.state, ['owner', 'admin'])
    const { data } = await client
      .from('workspaces')
      .select('id, slug, github_installation_id')
      .eq('id', query.state)
      .single()
    workspace = data
  }

  // Fallback to primary workspace if no state provided
  if (!workspace) {
    workspace = await getPrimaryWorkspace(useSupabaseUserClient(session.accessToken), session.user.id)
  }

  if (!workspace)
    throw createError({ statusCode: 404, message: errorMessage('github.workspace_not_found') })

  // Check if another workspace already uses this installation
  const admin = useSupabaseAdmin()
  const { data: existingWs } = await admin
    .from('workspaces')
    .select('id')
    .eq('github_installation_id', installationId)
    .neq('id', workspace.id)
    .single()

  if (existingWs)
    throw createError({ statusCode: 409, message: errorMessage('github.installation_linked') })
  const { error: updateError } = await admin
    .from('workspaces')
    .update({ github_installation_id: installationId })
    .eq('id', workspace.id)

  if (updateError) {
    throw createError({ statusCode: 500, message: updateError.message })
  }

  // Redirect to workspace dashboard
  await sendRedirect(event, `/w/${workspace.slug}`)
})
