/**
 * Get diff for a content branch compared to the default branch.
 * Returns file-level diffs with before/after content for JSON files.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const branch = getRouterParam(event, 'branch')

  if (!workspaceId || !projectId || !branch)
    throw createError({ statusCode: 400, message: 'workspaceId, projectId, and branch are required' })

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

  const files = await git.getBranchDiff(branch)

  // Load before/after content for each changed file
  const contents: Record<string, { before: unknown, after: unknown }> = {}
  const defaultBranch = await git.getDefaultBranch()

  for (const file of files) {
    let before: unknown = null
    let after: unknown = null

    // Read "before" from default branch
    if (file.status !== 'added') {
      try {
        const raw = await git.readFile(file.path, defaultBranch)
        before = file.path.endsWith('.json') ? JSON.parse(raw) : raw
      }
      catch { /* file may not exist on default branch */ }
    }

    // Read "after" from the content branch
    if (file.status !== 'removed') {
      try {
        const raw = await git.readFile(file.path, branch)
        after = file.path.endsWith('.json') ? JSON.parse(raw) : raw
      }
      catch { /* file may not exist on branch */ }
    }

    contents[file.path] = { before, after }
  }

  return { branch, files, contents }
})
