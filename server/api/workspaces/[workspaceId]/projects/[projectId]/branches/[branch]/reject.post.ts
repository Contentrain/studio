/**
 * Reject (delete) a content branch.
 * Requires reviewer, admin, or owner role.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const branch = getRouterParam(event, 'branch')

  if (!workspaceId || !projectId || !branch)
    throw createError({ statusCode: 400, message: 'workspaceId, projectId, and branch are required' })

  // Role check: only reviewer+ can reject
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('reject_branch'))
    throw createError({ statusCode: 403, message: 'Insufficient permissions to reject branches' })

  const client = useSupabaseUserClient(session.accessToken)

  const { data: project } = await client
    .from('projects')
    .select('repo_full_name, content_root, workspace_id')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: 'Project not found' })

  const { data: workspace } = await client
    .from('workspaces')
    .select('github_installation_id')
    .eq('id', workspaceId)
    .single()

  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: 'GitHub App not installed' })

  const [owner, repo] = project.repo_full_name.split('/')
  const git = useGitProvider({
    installationId: workspace.github_installation_id,
    owner,
    repo,
  })

  const engine = createContentEngine({ git, contentRoot: normalizeContentRoot(project.content_root) })
  await engine.rejectBranch(branch)
  return { rejected: true }
})
