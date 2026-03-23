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

  // Read content summaries
  const content: Record<string, { count: number, locales: string[] }> = {}
  try {
    const domains = await git.listDirectory(contentDir)
    for (const domain of domains) {
      try {
        const modelDirs = await git.listDirectory(`${contentDir}/${domain}`)
        for (const modelDir of modelDirs) {
          try {
            const files = await git.listDirectory(`${contentDir}/${domain}/${modelDir}`)
            const jsonFiles = files.filter(f => f.endsWith('.json'))
            content[modelDir] = { count: jsonFiles.length, locales: jsonFiles.map(f => f.replace('.json', '')) }
          }
          catch { /* skip */ }
        }
      }
      catch { /* domain might be a file */ }
    }
  }
  catch { /* no content directory */ }

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
