/**
 * Update .contentrain/vocabulary.json terms.
 * Merges provided terms with existing. Set a term value to null to delete it.
 * Always auto-merges.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<{ terms: Record<string, Record<string, string> | null> }>(event)

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  if (!body.terms || typeof body.terms !== 'object')
    throw createError({ statusCode: 400, message: 'terms object is required' })

  // Only owner/admin/editor can change vocabulary
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (permissions.availableTools.length === 0)
    throw createError({ statusCode: 403, message: 'No permissions' })

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

  const contentRoot = normalizeContentRoot(project.content_root)
  const vocabPath = contentRoot ? `${contentRoot}/.contentrain/vocabulary.json` : '.contentrain/vocabulary.json'

  // Read current vocabulary
  let vocabulary: { version: number, terms: Record<string, Record<string, string>> } = { version: 1, terms: {} }
  try {
    vocabulary = JSON.parse(await git.readFile(vocabPath)) as typeof vocabulary
  }
  catch { /* no existing vocabulary */ }

  // Merge terms (null = delete)
  const updatedTerms: Record<string, Record<string, string>> = {}
  for (const [key, existing] of Object.entries(vocabulary.terms)) {
    if (!(key in body.terms) || body.terms[key] !== null) {
      updatedTerms[key] = existing
    }
  }
  for (const [key, value] of Object.entries(body.terms)) {
    if (value !== null) {
      updatedTerms[key] = { ...(updatedTerms[key] ?? {}), ...value }
    }
  }
  vocabulary.terms = updatedTerms

  // Commit + auto-merge
  const branchName = `contentrain/vocab-${Date.now().toString(36)}`
  await git.createBranch(branchName)

  await git.commitFiles(
    branchName,
    [{ path: vocabPath, content: JSON.stringify(vocabulary, null, 2) + '\n' }],
    `contentrain: update vocabulary`,
    { name: 'Contentrain Studio[bot]', email: 'bot@contentrain.io' },
  )

  const defaultBranch = await git.getDefaultBranch()
  const mergeResult = await git.mergeBranch(branchName, defaultBranch)

  if (mergeResult.merged) {
    try {
      await git.deleteBranch(branchName)
    }
    catch { /* auto-deleted */ }
  }

  return { vocabulary, merged: mergeResult.merged }
})
