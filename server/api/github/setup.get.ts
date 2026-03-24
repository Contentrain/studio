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
  }

  if (!query.installation_id) {
    throw createError({ statusCode: 400, message: 'Missing installation_id' })
  }

  const installationId = Number(query.installation_id)
  if (!installationId || Number.isNaN(installationId))
    throw createError({ statusCode: 400, message: 'Invalid installation_id' })

  const workspace = await getPrimaryWorkspace(useSupabaseUserClient(session.accessToken), session.user.id)

  if (!workspace)
    throw createError({ statusCode: 404, message: 'No workspace found' })

  // Check if another workspace already uses this installation
  const admin = useSupabaseAdmin()
  const { data: existingWs } = await admin
    .from('workspaces')
    .select('id')
    .eq('github_installation_id', installationId)
    .neq('id', workspace.id)
    .single()

  if (existingWs)
    throw createError({ statusCode: 409, message: 'This GitHub installation is already linked to another workspace' })
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
