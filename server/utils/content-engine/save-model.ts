import type { ContentrainConfig, ModelDefinition } from '@contentrain/types'
import type { EngineInternalContext, WriteResult } from './types'
import { BOT_AUTHOR, CONTENT_BRANCH } from './types'
import { buildContextUpdate, createFeatureBranch } from './helpers'

/**
 * Save a model definition.
 */
export async function saveModel(
  ctx: EngineInternalContext,
  definition: ModelDefinition,
  userEmail: string,
): Promise<WriteResult> {
  await ctx.ensureContentBranch()

  // Validate model definition before saving
  const { validateModelDefinition } = await import('../schema-validation')
  // Get existing model IDs for relation target validation
  let existingModelIds: string[] = []
  try {
    const modelsDir = resolveModelsDir(ctx.pathCtx)
    const files = await ctx.git.listDirectory(modelsDir, CONTENT_BRANCH)
    existingModelIds = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
  }
  catch { /* no models dir yet */ }
  // Include the current model in the list (it may be new)
  if (!existingModelIds.includes(definition.id)) {
    existingModelIds.push(definition.id)
  }

  // Read config for domain validation
  let config: ContentrainConfig | null = null
  try {
    config = JSON.parse(await ctx.git.readFile(resolveConfigPath(ctx.pathCtx), CONTENT_BRANCH)) as ContentrainConfig
  }
  catch { /* no config */ }

  const schemaWarnings = validateModelDefinition(definition, config, existingModelIds)
  const criticalErrors = schemaWarnings.filter(w => w.severity === 'critical' || w.severity === 'error')
  if (criticalErrors.length > 0) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
      diff: [],
      validation: {
        valid: false,
        errors: criticalErrors.map(w => ({ field: w.field ?? '', message: w.message, severity: 'error' as const })),
      },
    }
  }

  const modelPath = resolveModelPath(ctx.pathCtx, definition.id)
  const serialized = serializeCanonical(definition)

  // Context.json update
  const contextPath = resolveContextPath(ctx.pathCtx)
  const projectInfo = await ctx.getProjectInfo('en')
  // +1 if this is a new model
  let isNew = false
  try {
    await ctx.git.readFile(modelPath, CONTENT_BRANCH)
  }
  catch {
    isNew = true
  }
  const contextJson = await buildContextUpdate(ctx, contextPath, { tool: 'save_model', model: definition.id, locale: '' }, projectInfo.modelCount + (isNew ? 1 : 0), projectInfo.locales, CONTENT_BRANCH)

  const { branchName } = await createFeatureBranch(ctx, 'model', definition.id)

  const message = `contentrain: save model ${definition.id}\n\nCo-Authored-By: ${userEmail}`
  const commit = await ctx.git.commitFiles(
    branchName,
    [
      { path: modelPath, content: serialized },
      { path: contextPath, content: contextJson },
    ],
    message,
    BOT_AUTHOR,
  )

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}
