/**
 * Read content entries for a specific model.
 *
 * Returns the parsed JSON content for the given model and locale.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')
  const query = getQuery(event) as { locale?: string }

  if (!workspaceId || !projectId || !modelId)
    throw createError({ statusCode: 400, message: 'workspaceId, projectId, and modelId are required' })

  const locale = query.locale || 'en'
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

  const contentRoot = project.content_root === '/' ? '' : project.content_root.replace(/^\/|\/$/g, '')
  const contentBase = contentRoot ? `${contentRoot}/.contentrain/content` : '.contentrain/content'

  // Try to find content file in domain subdirectories
  let contentData: unknown = null
  try {
    const domains = await git.listDirectory(contentBase)
    for (const domain of domains) {
      const filePath = `${contentBase}/${domain}/${modelId}/${locale}.json`
      if (await git.fileExists(filePath)) {
        const raw = await git.readFile(filePath)
        contentData = JSON.parse(raw)
        break
      }
    }
  }
  catch {
    // Content not found
  }

  if (!contentData) {
    // Try flat structure: .contentrain/content/modelId/locale.json
    try {
      const filePath = `${contentBase}/${modelId}/${locale}.json`
      const raw = await git.readFile(filePath)
      contentData = JSON.parse(raw)
    }
    catch {
      contentData = null
    }
  }

  return {
    modelId,
    locale,
    data: contentData,
  }
})
