import type { ModelDefinition } from '@contentrain/types'
import type { EngineInternalContext, WriteResult } from './types'
import { BOT_AUTHOR, CONTENT_BRANCH } from './types'
import { buildContextUpdate, createFeatureBranch, toObjectMap } from './helpers'

/**
 * Delete content entries from a collection.
 */
export async function deleteContent(
  ctx: EngineInternalContext,
  modelId: string,
  locale: string,
  entryIds: string[],
  userEmail: string,
): Promise<WriteResult> {
  await ctx.ensureContentBranch()

  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await ctx.git.readFile(modelPath, CONTENT_BRANCH)) as ModelDefinition
  const contentPath = resolveContentPath(ctx.pathCtx, modelDef, locale)

  // Read existing (normalize array -> object-map)
  const raw = JSON.parse(await ctx.git.readFile(contentPath, CONTENT_BRANCH))
  const existing = toObjectMap(raw)

  // Remove entries by rebuilding without deleted IDs
  const filtered = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !entryIds.includes(key)),
  )

  const serialized = serializeCanonical(filtered)

  // Clean meta entries too
  const metaPath = resolveMetaPath(ctx.pathCtx, modelDef, locale)
  let existingMeta: Record<string, unknown> = {}
  try {
    existingMeta = JSON.parse(await ctx.git.readFile(metaPath, CONTENT_BRANCH)) as Record<string, unknown>
  }
  catch { /* no meta */ }
  const filteredMeta = Object.fromEntries(
    Object.entries(existingMeta).filter(([key]) => !entryIds.includes(key)),
  )

  // Context.json update
  const contextPath = resolveContextPath(ctx.pathCtx)
  const projectInfo = await ctx.getProjectInfo(locale)
  const contextJson = await buildContextUpdate(ctx, contextPath, { tool: 'delete_content', model: modelId, locale, entries: entryIds }, projectInfo.modelCount, projectInfo.locales, CONTENT_BRANCH)

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId, locale)

  const message = `contentrain: delete ${entryIds.length} entries from ${modelId} [${locale}]\n\nCo-Authored-By: ${userEmail}`
  const commit = await ctx.git.commitFiles(
    branchName,
    [
      { path: contentPath, content: serialized },
      { path: metaPath, content: serializeCanonical(filteredMeta) },
      { path: contextPath, content: contextJson },
    ],
    message,
    BOT_AUTHOR,
  )

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)

  return {
    branch: branchName,
    commit,
    diff,
    validation: { valid: true, errors: [] },
  }
}
