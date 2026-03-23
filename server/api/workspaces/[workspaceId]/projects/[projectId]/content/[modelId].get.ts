import type { ModelDefinition } from '@contentrain/types'
import matter from 'gray-matter'

/**
 * Read content for a specific model.
 *
 * Uses resolveContentPath() for correct path resolution including:
 * - contentRoot prefix (monorepo)
 * - content_path overrides (custom paths outside .contentrain/)
 * - i18n vs non-i18n (locale.json vs data.json)
 * - Document kind (slug directories or flat .md files)
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

  const ctx = { contentRoot }

  // Read model definition
  let modelDef: ModelDefinition
  try {
    modelDef = JSON.parse(await git.readFile(resolveModelPath(ctx, modelId))) as ModelDefinition
  }
  catch {
    throw createError({ statusCode: 404, message: `Model "${modelId}" not found` })
  }

  const kind = modelDef.kind ?? 'collection'
  const effectiveLocale = modelDef.i18n ? locale : 'data'

  // Document kind
  if (kind === 'document') {
    return readDocumentContent(git, ctx, modelDef, locale)
  }

  // JSON kinds: singleton, collection, dictionary
  const contentPath = resolveContentPath(ctx, modelDef, effectiveLocale === 'data' ? 'data' : locale)
  let contentData: unknown = null

  try {
    contentData = JSON.parse(await git.readFile(contentPath))
  }
  catch { /* content not found */ }

  // Load meta
  let meta: Record<string, unknown> | null = null
  try {
    const metaPath = resolveMetaPath(ctx, modelDef, effectiveLocale === 'data' ? locale : locale)
    meta = JSON.parse(await git.readFile(metaPath)) as Record<string, unknown>
  }
  catch { /* no meta */ }

  return { modelId, locale, kind, data: contentData, meta }
})

/**
 * Read document model content — handles content_path override, i18n/non-i18n.
 */
async function readDocumentContent(
  git: ReturnType<typeof useGitProvider>,
  ctx: { contentRoot: string },
  model: ModelDefinition,
  locale: string,
) {
  const contentDir = model.content_path
    ? (ctx.contentRoot ? `${ctx.contentRoot}/${model.content_path}` : model.content_path)
    : `${ctx.contentRoot ? `${ctx.contentRoot}/` : ''}.contentrain/content/${model.domain}/${model.id}`

  const entries: Array<{ slug: string, frontmatter: Record<string, unknown>, body: string }> = []

  try {
    const items = await git.listDirectory(contentDir)

    for (const item of items) {
      if (!model.i18n && item.endsWith('.md')) {
        // Non-i18n: flat .md files
        try {
          const raw = await git.readFile(`${contentDir}/${item}`)
          const parsed = matter(raw)
          entries.push({ slug: item.replace('.md', ''), frontmatter: parsed.data, body: parsed.content })
        }
        catch { /* skip */ }
      }
      else if (model.i18n && !item.includes('.')) {
        // i18n: slug directories with {locale}.md
        try {
          const raw = await git.readFile(`${contentDir}/${item}/${locale}.md`)
          const parsed = matter(raw)
          entries.push({ slug: item, frontmatter: parsed.data, body: parsed.content })
        }
        catch { /* skip */ }
      }
    }
  }
  catch { /* directory not accessible */ }

  // Load meta
  let meta: Record<string, unknown> | null = null
  try {
    const metaPath = resolveMetaPath(ctx, model, locale)
    meta = JSON.parse(await git.readFile(metaPath)) as Record<string, unknown>
  }
  catch { /* no meta */ }

  return { modelId: model.id, locale, kind: 'document', data: entries, meta }
}
