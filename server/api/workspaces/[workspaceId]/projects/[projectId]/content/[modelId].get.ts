import type { ModelDefinition } from '@contentrain/types'
import matter from 'gray-matter'

/**
 * Read content for a specific model.
 *
 * Handles all 4 kinds:
 * - singleton: flat object from .contentrain/content/{domain}/{model}/{locale}.json
 * - collection: object-map from .contentrain/content/{domain}/{model}/{locale}.json
 * - dictionary: key-value pairs from .contentrain/content/{domain}/{model}/{locale}.json
 * - document: frontmatter + markdown from {content_path}/{slug}.md or {slug}/{locale}.md
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
  let modelDef: Partial<ModelDefinition> = {}
  try {
    modelDef = JSON.parse(await git.readFile(`${modelsDir}/${modelId}.json`))
  }
  catch {
    // Model definition not found — try reading content anyway
  }

  const kind = modelDef.kind ?? 'collection'
  const domain = modelDef.domain

  // Document kind: content_path points directly to the directory containing .md files
  // Structure: {content_path}/{slug}.md (non-i18n) or {content_path}/{slug}/{locale}.md (i18n)
  if (kind === 'document' && modelDef.content_path) {
    const docPath = contentRoot ? `${contentRoot}/${modelDef.content_path}` : modelDef.content_path
    const entries: Array<{ slug: string, frontmatter: Record<string, unknown>, body: string }> = []
    const isI18n = modelDef.i18n ?? false

    try {
      const items = await git.listDirectory(docPath)

      for (const item of items) {
        // Non-i18n: {content_path}/{slug}.md
        if (!isI18n && item.endsWith('.md')) {
          try {
            const raw = await git.readFile(`${docPath}/${item}`)
            const parsed = matter(raw)
            entries.push({ slug: item.replace('.md', ''), frontmatter: parsed.data, body: parsed.content })
          }
          catch { /* skip */ }
        }
        // i18n: {content_path}/{slug}/{locale}.md
        else if (isI18n && !item.includes('.')) {
          try {
            const raw = await git.readFile(`${docPath}/${item}/${locale}.md`)
            const parsed = matter(raw)
            entries.push({ slug: item, frontmatter: parsed.data, body: parsed.content })
          }
          catch { /* skip */ }
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

// gray-matter handles all frontmatter edge cases: nested YAML, arrays, quotes, multiline
