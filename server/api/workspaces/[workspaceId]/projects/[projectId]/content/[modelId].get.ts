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

  const { git, contentRoot } = await resolveProjectContext(
    useSupabaseUserClient(session.accessToken), workspaceId, projectId,
  )

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
  if (kind === 'document' && modelDef.content_path) {
    const docPath = contentRoot ? `${contentRoot}/${modelDef.content_path}` : modelDef.content_path
    const entries: Array<{ slug: string, frontmatter: Record<string, unknown>, body: string }> = []
    const isI18n = modelDef.i18n ?? false

    try {
      const items = await git.listDirectory(docPath)

      for (const item of items) {
        if (!isI18n && item.endsWith('.md')) {
          try {
            const raw = await git.readFile(`${docPath}/${item}`)
            const parsed = matter(raw)
            entries.push({ slug: item.replace('.md', ''), frontmatter: parsed.data, body: parsed.content })
          }
          catch { /* skip */ }
        }
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

    // Load document meta
    let docMeta: Record<string, unknown> | null = null
    try {
      const metaBase = contentRoot ? `${contentRoot}/.contentrain/meta` : '.contentrain/meta'
      docMeta = JSON.parse(await git.readFile(`${metaBase}/${modelId}/${locale}.json`))
    }
    catch { /* no meta */ }

    return { modelId, locale, kind, data: entries, meta: docMeta }
  }

  // JSON-based kinds: singleton, collection, dictionary
  let contentData: unknown = null

  if (domain) {
    try {
      contentData = JSON.parse(await git.readFile(`${contentBase}/${domain}/${modelId}/${locale}.json`))
    }
    catch { /* Not found at domain path */ }
  }

  if (!contentData) {
    try {
      const domains = await git.listDirectory(contentBase)
      for (const d of domains) {
        if (d.startsWith('.')) continue
        try {
          contentData = JSON.parse(await git.readFile(`${contentBase}/${d}/${modelId}/${locale}.json`))
          break
        }
        catch { continue }
      }
    }
    catch { /* Content base not accessible */ }
  }

  // Load meta
  let meta: Record<string, unknown> | null = null
  try {
    const metaBase = contentRoot ? `${contentRoot}/.contentrain/meta` : '.contentrain/meta'
    meta = JSON.parse(await git.readFile(`${metaBase}/${modelId}/${locale}.json`))
  }
  catch { /* no meta */ }

  return { modelId, locale, kind, data: contentData, meta }
})
