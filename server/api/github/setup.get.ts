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
  const client = useSupabaseUserClient(session.accessToken)

  // Find the user's workspace and save installation_id
  // For now, save to the first workspace owned by the user
  const { data: workspace, error } = await client
    .from('workspaces')
    .select('id, slug')
    .eq('owner_id', session.user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .single()

  if (error || !workspace) {
    throw createError({ statusCode: 404, message: 'No workspace found' })
  }

  // Save installation_id to workspace (using admin to bypass RLS for update)
  const admin = useSupabaseAdmin()
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
