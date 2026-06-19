import type { ContentrainConfig, FileChange, ModelDefinition } from '@contentrain/types'
import { CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH } from '@contentrain/types'
import { planModelSave } from '@contentrain/mcp/core/ops'
import type { EngineInternalContext, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
import { pinReaderToContentrain, createFeatureBranch } from './helpers'

/**
 * Save a model definition (create or update).
 *
 * Schema validation (Studio-owned today, pending S3 unification with MCP)
 * runs first; if it passes, file assembly is delegated to
 * `planModelSave` — it writes `.contentrain/models/{id}.json` in
 * canonical form. `context.json` is regenerated on `contentrain`
 * post-merge (MCP 1.5.0 model), not committed on the feature branch.
 */
export async function saveModel(
  ctx: EngineInternalContext,
  definition: ModelDefinition,
  userEmail: string,
): Promise<WriteResult> {
  await ctx.ensureContentBranch()

  const reader = pinReaderToContentrain(ctx.git)

  const { validateModelDefinition } = await import('../schema-validation')

  let existingModelIds: string[] = []
  try {
    const modelsDir = resolveModelsDir(ctx.pathCtx)
    const files = await reader.listDirectory(modelsDir)
    existingModelIds = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
  }
  catch { /* no models dir yet */ }
  if (!existingModelIds.includes(definition.id)) {
    existingModelIds.push(definition.id)
  }

  let config: ContentrainConfig | null = null
  try {
    config = JSON.parse(await reader.readFile(resolveConfigPath(ctx.pathCtx))) as ContentrainConfig
  }
  catch { /* no config */ }

  const schemaWarnings = validateModelDefinition(definition, config, existingModelIds)
  const criticalErrors = schemaWarnings.filter(w => w.severity === 'critical' || w.severity === 'error')
  if (criticalErrors.length > 0) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
      diff: [],
      validation: {
        valid: false,
        errors: criticalErrors.map(w => ({
          field: w.field ?? '',
          message: w.message,
          severity: 'error' as const,
        })),
      },
    }
  }

  let plan
  try {
    plan = await planModelSave(reader, { model: definition })
  }
  catch (err) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
      diff: [],
      validation: {
        valid: false,
        errors: [{
          field: '',
          message: err instanceof Error ? err.message : String(err),
          severity: 'error' as const,
        }],
      },
    }
  }

  const allChanges: FileChange[] = [...plan.changes]
    .toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'model', definition.id)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: save model ${definition.id}\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}
