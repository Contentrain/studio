/**
 * Scan a repository for .contentrain/ and detect framework.
 *
 * Called during project connection to determine:
 * - Path A: .contentrain/ exists → ready to connect
 * - Path B: no .contentrain/ → needs init (Phase 2 via chat)
 * - Framework detection for content path suggestions
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const query = getQuery(event) as {
    workspaceId?: string
    owner?: string
    repo?: string
  }

  if (!query.workspaceId || !query.owner || !query.repo)
    throw createError({ statusCode: 400, message: 'workspaceId, owner, and repo are required' })

  const client = useSupabaseUserClient(session.accessToken)

  // Get workspace installation_id
  const { data: workspace } = await client
    .from('workspaces')
    .select('github_installation_id')
    .eq('id', query.workspaceId)
    .single()

  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: 'GitHub App not installed' })

  // Create GitProvider for this repo
  const git = useGitProvider({
    installationId: workspace.github_installation_id,
    owner: query.owner,
    repo: query.repo,
  })

  const detection = await git.detectFramework()
  const defaultBranch = await git.getDefaultBranch()

  return {
    defaultBranch,
    ...detection,
  }
})
