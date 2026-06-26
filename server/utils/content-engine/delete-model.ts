import type { FileChange, ModelDefinition } from '@contentrain/types'
import { CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH } from '@contentrain/types'
import { planModelDelete } from '@contentrain/mcp/core/ops'
import type { EngineInternalContext, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
import { pinReaderToContentrain, createFeatureBranch } from './helpers'

/**
 * Delete a model definition and all of its content + meta files.
 *
 * DESTRUCTIVE: removes `.contentrain/models/{id}.json` plus every content
 * and meta file for the model (all locales / slugs). File assembly is
 * delegated to `@contentrain/mcp/core/ops:planModelDelete`, which resolves
 * the correct paths for every kind + locale strategy (it emits FileChanges
 * with `content: null` to mark deletions). `context.json` is regenerated on
 * `contentrain` post-merge, not committed on the feature branch.
 */
export async function deleteModel(
  ctx: EngineInternalContext,
  modelId: string,
  userEmail: string,
): Promise<WriteResult> {
  await ctx.ensureContentBranch()

  const reader = pinReaderToContentrain(ctx.git)

  let modelDef: ModelDefinition
  try {
    modelDef = JSON.parse(await reader.readFile(resolveModelPath(ctx.pathCtx, modelId))) as ModelDefinition
  }
  catch {
    return {
      branch: '',
      commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
      diff: [],
      validation: { valid: false, errors: [{ field: '', message: `Model "${modelId}" not found`, severity: 'error' as const }] },
    }
  }

  const plan = await planModelDelete(reader, { model: modelDef })
  const allChanges: FileChange[] = [...plan.changes]
    .toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'model', modelId)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: delete model ${modelId}\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}
