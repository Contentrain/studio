/**
 * Save content for a model.
 * Uses Content Engine: validate → serialize → branch → commit → diff.
 *
 * Body: { locale, data, entryId? }
 * - Collection: data = { entryId: { fields } } or full object-map
 * - Singleton: data = { field: value }
 * - Dictionary: data = { key: value }
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')
  const body = await readBody<{
    locale?: string
    data: Record<string, unknown>
  }>(event)

  if (!workspaceId || !projectId || !modelId)
    throw createError({ statusCode: 400, message: 'workspaceId, projectId, and modelId are required' })

  if (!body.data)
    throw createError({ statusCode: 400, message: 'data is required' })

  const locale = body.locale ?? 'en'
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
  const engine = createContentEngine({ git, contentRoot })

  const result = await engine.saveContent(
    modelId,
    locale,
    body.data,
    session.user.email ?? '',
  )

  return result
})
