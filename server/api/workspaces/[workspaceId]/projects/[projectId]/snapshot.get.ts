/**
 * Content Snapshot API.
 *
 * Reads .contentrain/ directory from the repository via GitProvider.
 * Returns models, config, and content entries as a single JSON payload.
 *
 * Client caches this in memory (Phase 1) or IndexedDB (Phase 6+).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  const client = useSupabaseUserClient(session.accessToken)

  // Get project + workspace installation
  const { data: project } = await client
    .from('projects')
    .select('repo_full_name, default_branch, content_root, workspace_id')
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

  // Read .contentrain/ tree
  const contentRoot = project.content_root === '/' ? '' : project.content_root.replace(/^\/|\/$/g, '')
  const configPath = contentRoot ? `${contentRoot}/.contentrain/config.json` : '.contentrain/config.json'
  const modelsDir = contentRoot ? `${contentRoot}/.contentrain/models` : '.contentrain/models'
  const contentDir = contentRoot ? `${contentRoot}/.contentrain/content` : '.contentrain/content'

  // Check if .contentrain/ exists
  const hasConfig = await git.fileExists(configPath)

  if (!hasConfig) {
    return {
      exists: false,
      config: null,
      models: [],
      content: {},
    }
  }

  // Read config
  let config = null
  try {
    config = JSON.parse(await git.readFile(configPath))
  }
  catch {
    config = null
  }

  // Read models
  const models: Array<{ id: string, name: string, type: string, fields: unknown[] }> = []
  try {
    const modelFiles = await git.listDirectory(modelsDir)
    for (const file of modelFiles) {
      if (!file.endsWith('.json')) continue
      try {
        const modelContent = JSON.parse(await git.readFile(`${modelsDir}/${file}`))
        models.push({
          id: file.replace('.json', ''),
          name: modelContent.name ?? file.replace('.json', ''),
          type: modelContent.type ?? 'collection',
          fields: modelContent.fields ?? [],
        })
      }
      catch {
        // Skip invalid model files
      }
    }
  }
  catch {
    // No models directory
  }

  // Read content entries (summary — not full content, just counts and IDs)
  const content: Record<string, { count: number, locales: string[] }> = {}
  try {
    const domains = await git.listDirectory(contentDir)
    for (const domain of domains) {
      const domainPath = `${contentDir}/${domain}`
      try {
        const modelDirs = await git.listDirectory(domainPath)
        for (const modelDir of modelDirs) {
          const modelPath = `${domainPath}/${modelDir}`
          try {
            const files = await git.listDirectory(modelPath)
            const jsonFiles = files.filter(f => f.endsWith('.json'))
            const locales = jsonFiles.map(f => f.replace('.json', ''))
            content[modelDir] = {
              count: jsonFiles.length,
              locales,
            }
          }
          catch {
            // Skip
          }
        }
      }
      catch {
        // Domain might be a file, not directory
      }
    }
  }
  catch {
    // No content directory
  }

  return {
    exists: true,
    config,
    models,
    content,
  }
})
