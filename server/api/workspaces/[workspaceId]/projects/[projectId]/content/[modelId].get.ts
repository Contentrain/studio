/**
 * Read content for a specific model.
 *
 * Handles all 4 kinds:
 * - singleton: flat object from .contentrain/content/{domain}/{model}/{locale}.json
 * - collection: object-map from .contentrain/content/{domain}/{model}/{locale}.json
 * - dictionary: key-value pairs from .contentrain/content/{domain}/{model}/{locale}.json
 * - document: frontmatter + markdown from {content_path}/{slug}/{locale}.md
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
  const modelsDir = contentRoot ? `${contentRoot}/.contentrain/models` : '.contentrain/models'
  const contentBase = contentRoot ? `${contentRoot}/.contentrain/content` : '.contentrain/content'

  // Read model definition to determine kind, domain, content_path
  let modelDef: { kind?: string, domain?: string, content_path?: string } = {}
  try {
    modelDef = JSON.parse(await git.readFile(`${modelsDir}/${modelId}.json`))
  }
  catch {
    // Model definition not found — try reading content anyway
  }

  const kind = modelDef.kind ?? 'collection'
  const domain = modelDef.domain

  // Document kind: read from content_path (outside .contentrain/content/)
  if (kind === 'document' && modelDef.content_path) {
    const docPath = contentRoot ? `${contentRoot}/${modelDef.content_path}` : modelDef.content_path
    const entries: Array<{ slug: string, frontmatter: Record<string, unknown>, body: string }> = []

    try {
      // Documents are stored as: {content_path}/{model}/{slug}/{locale}.md
      const modelDir = `${docPath}/${modelId}`
      let slugDirs: string[] = []

      try {
        slugDirs = await git.listDirectory(modelDir)
      }
      catch {
        // Try without modelId subdirectory: {content_path}/{slug}/{locale}.md
        slugDirs = await git.listDirectory(docPath)
      }

      for (const slugDir of slugDirs) {
        const mdPath = `${modelDir}/${slugDir}/${locale}.md`
        try {
          const raw = await git.readFile(mdPath)
          const { frontmatter, body } = parseFrontmatter(raw)
          entries.push({ slug: slugDir, frontmatter, body })
        }
        catch {
          // Try non-localized: {content_path}/{model}/{slug}.md
          try {
            const altPath = `${modelDir}/${slugDir}.md`
            const raw = await git.readFile(altPath)
            const { frontmatter, body } = parseFrontmatter(raw)
            entries.push({ slug: slugDir.replace('.md', ''), frontmatter, body })
          }
          catch {
            // Skip
          }
        }
      }
    }
    catch {
      // Document path not accessible
    }

    return { modelId, locale, kind, data: entries }
  }

  // JSON-based kinds: singleton, collection, dictionary
  let contentData: unknown = null

  // Try with domain: .contentrain/content/{domain}/{modelId}/{locale}.json
  if (domain) {
    try {
      const filePath = `${contentBase}/${domain}/${modelId}/${locale}.json`
      contentData = JSON.parse(await git.readFile(filePath))
    }
    catch {
      // Not found at domain path
    }
  }

  // Fallback: scan all domain directories
  if (!contentData) {
    try {
      const domains = await git.listDirectory(contentBase)
      for (const d of domains) {
        if (d.startsWith('.')) continue
        const filePath = `${contentBase}/${d}/${modelId}/${locale}.json`
        try {
          contentData = JSON.parse(await git.readFile(filePath))
          break
        }
        catch {
          continue
        }
      }
    }
    catch {
      // Content base not accessible
    }
  }

  return { modelId, locale, kind, data: contentData }
})

/**
 * Parse markdown frontmatter (YAML between --- delimiters).
 * Simple parser — handles key: value pairs, not nested YAML.
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>, body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: raw }

  const fm: Record<string, unknown> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.substring(0, idx).trim()
    let value: unknown = line.substring(idx + 1).trim()
    // Simple type coercion
    if (value === 'true') value = true
    else if (value === 'false') value = false
    else if (!Number.isNaN(Number(value)) && value !== '') value = Number(value)
    // Remove quotes
    else if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    fm[key] = value
  }

  return { frontmatter: fm, body: match[2] }
}
