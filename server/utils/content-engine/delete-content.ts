import type { ContentrainConfig, FileChange, ModelDefinition, RepoReader } from '@contentrain/types'
import { CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH } from '@contentrain/types'
import { planContentDelete } from '@contentrain/mcp/core/ops'
import { OverlayReader } from '@contentrain/mcp/core/overlay-reader'
import type { EngineInternalContext, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
import { pinReaderToContentrain, createFeatureBranch } from './helpers'

/**
 * Delete content entries from a collection.
 *
 * `planContentDelete` handles one entry id per call. Studio's public
 * API accepts a batch, so we fan out and chain `OverlayReader`s:
 * every subsequent plan sees the post-delete state of the prior plan,
 * which keeps the running content-map + meta-map correct even when
 * multiple deletions collapse into one file.
 */
export async function deleteContent(
  ctx: EngineInternalContext,
  modelId: string,
  locale: string,
  entryIds: string[],
  userEmail: string,
): Promise<WriteResult> {
  await ctx.ensureContentBranch()

  const reader = pinReaderToContentrain(ctx.git)

  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await reader.readFile(modelPath)) as ModelDefinition

  // MCP 2.x `planContentDelete` needs the default locale to resolve a non-i18n
  // model's single meta record (it lives under the default locale, not the
  // caller's). Read it from config — same source `planContentSave` uses.
  const config = JSON.parse(await reader.readFile(resolveConfigPath(ctx.pathCtx))) as ContentrainConfig
  const defaultLocale = config.locales?.default ?? 'en'

  let workingReader: RepoReader = reader
  const changesByPath = new Map<string, FileChange>()

  for (const id of entryIds) {
    const plan = await planContentDelete(workingReader, { model: modelDef, id, locale, defaultLocale })
    for (const change of plan.changes) {
      changesByPath.set(change.path, change)
    }
    workingReader = new OverlayReader(workingReader, plan.changes)
  }

  const aggregatedChanges = [...changesByPath.values()]

  // context.json is regenerated on `contentrain` post-merge (MCP 1.5.0
  // model), not committed on the feature branch.
  const allChanges: FileChange[] = [...aggregatedChanges]
    .toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId, locale)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: delete ${entryIds.length} entries from ${modelId} [${locale}]\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)

  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}
