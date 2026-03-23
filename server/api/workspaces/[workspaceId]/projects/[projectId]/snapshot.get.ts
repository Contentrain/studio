import type { ContentrainConfig, ModelDefinition, ModelKind } from '@contentrain/types'

/**
 * Content Snapshot API.
 *
 * Reads .contentrain/ directory from the repository via GitProvider.
 * Returns models, config, and content entries as a single JSON payload.
 * Uses @contentrain/types as the contract for model/config shapes.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  const { git, contentRoot } = await resolveProjectContext(
    useSupabaseUserClient(session.accessToken), workspaceId, projectId,
  )

  const configPath = contentRoot ? `${contentRoot}/.contentrain/config.json` : '.contentrain/config.json'
  const modelsDir = contentRoot ? `${contentRoot}/.contentrain/models` : '.contentrain/models'
  const contentDir = contentRoot ? `${contentRoot}/.contentrain/content` : '.contentrain/content'

  // Check if .contentrain/ exists
  const hasConfig = await git.fileExists(configPath)

  if (!hasConfig) {
    return { exists: false, config: null, models: [], content: {} }
  }

  // Read config
  let config: ContentrainConfig | null = null
  try {
    config = JSON.parse(await git.readFile(configPath)) as ContentrainConfig
  }
  catch { config = null }

  // Read models
  const models: Array<{ id: string, name: string, kind: ModelKind, type: ModelKind, fields: Record<string, unknown>, domain: string, i18n: boolean }> = []
  try {
    const modelFiles = await git.listDirectory(modelsDir)
    for (const file of modelFiles) {
      if (!file.endsWith('.json')) continue
      try {
        const def = JSON.parse(await git.readFile(`${modelsDir}/${file}`)) as ModelDefinition
        models.push({
          id: def.id ?? file.replace('.json', ''),
          name: def.name ?? file.replace('.json', ''),
          kind: def.kind ?? 'collection',
          type: def.kind ?? 'collection',
          fields: (def.fields ?? {}) as Record<string, unknown>,
          domain: def.domain ?? '',
          i18n: def.i18n ?? false,
        })
      }
      catch { /* skip invalid model files */ }
    }
  }
  catch { /* no models directory */ }

  // Read content summaries — uses model definitions for correct path resolution
  const content: Record<string, { count: number, locales: string[] }> = {}
  const ctx = { contentRoot }
  const defaultLocale = config?.locales?.default ?? 'en'
  const supportedLocales = config?.locales?.supported ?? [defaultLocale]

  for (const model of models) {
    try {
      if (model.kind === 'document') {
        // Documents: count slugs in content directory
        const contentDirPath = (model as { content_path?: string }).content_path
          ? (contentRoot ? `${contentRoot}/${(model as { content_path?: string }).content_path}` : (model as { content_path?: string }).content_path!)
          : `${contentDir}/${model.domain}/${model.id}`
        const items = await git.listDirectory(contentDirPath)
        const slugs = model.i18n ? items.filter(i => !i.includes('.')) : items.filter(i => i.endsWith('.md'))
        content[model.id] = { count: slugs.length, locales: model.i18n ? supportedLocales : [defaultLocale] }
      }
      else {
        // JSON kinds: count entries by reading locale files
        const locales: string[] = []
        let entryCount = 0

        for (const locale of (model.i18n ? supportedLocales : ['data'])) {
          try {
            const filePath = resolveContentPath(ctx, model as unknown as ModelDefinition, locale)
            const raw = await git.readFile(filePath)
            const data = JSON.parse(raw)
            locales.push(locale === 'data' ? defaultLocale : locale)
            if (model.kind === 'collection' && typeof data === 'object' && !Array.isArray(data)) {
              entryCount = Math.max(entryCount, Object.keys(data).length)
            }
            else if (model.kind === 'collection' && Array.isArray(data)) {
              entryCount = Math.max(entryCount, data.length)
            }
            else {
              entryCount = 1
            }
          }
          catch { /* locale not found */ }
        }

        content[model.id] = { count: entryCount, locales }
      }
    }
    catch { /* skip model */ }
  }

  // Read vocabulary
  let vocabulary: Record<string, Record<string, string>> | null = null
  try {
    const vocabPath = contentRoot ? `${contentRoot}/.contentrain/vocabulary.json` : '.contentrain/vocabulary.json'
    const vocabData = JSON.parse(await git.readFile(vocabPath)) as { terms?: Record<string, Record<string, string>> }
    vocabulary = vocabData.terms ?? null
  }
  catch { /* no vocabulary */ }

  // Read context.json
  let contentContext: { lastOperation?: { tool?: string, model?: string, locale?: string, timestamp?: string }, stats?: { models?: number, entries?: number, locales?: string[] } } | null = null
  try {
    const ctxPath = contentRoot ? `${contentRoot}/.contentrain/context.json` : '.contentrain/context.json'
    contentContext = JSON.parse(await git.readFile(ctxPath))
  }
  catch { /* no context */ }

  return { exists: true, config, models, content, vocabulary, contentContext }
})
