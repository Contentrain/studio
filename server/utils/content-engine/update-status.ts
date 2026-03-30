import type { EntryMeta, ModelDefinition } from '@contentrain/types'
import type { EngineInternalContext, WriteResult } from './types'
import { BOT_AUTHOR, CONTENT_BRANCH } from './types'
import { buildContextUpdate, generateBranchName } from './helpers'

/**
 * Update entry status (publish/unpublish/archive).
 * Only modifies meta, not content.
 */
export async function updateEntryStatus(
  ctx: EngineInternalContext,
  modelId: string,
  locale: string,
  entryIds: string[],
  status: 'draft' | 'published' | 'archived',
  userEmail: string,
): Promise<WriteResult> {
  await ctx.ensureContentBranch()

  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await ctx.git.readFile(modelPath, CONTENT_BRANCH)) as ModelDefinition
  const metaPath = resolveMetaPath(ctx.pathCtx, modelDef, locale)

  let existingMeta: Record<string, EntryMeta> = {}
  try {
    existingMeta = JSON.parse(await ctx.git.readFile(metaPath, CONTENT_BRANCH)) as Record<string, EntryMeta>
  }
  catch { /* no meta */ }

  for (const entryId of entryIds) {
    existingMeta[entryId] = {
      ...(existingMeta[entryId] ?? {}),
      status,
      updated_by: userEmail,
    } as EntryMeta
  }

  const branchName = generateBranchName('content', modelId, locale)
  await ctx.git.createBranch(branchName, CONTENT_BRANCH)

  const commit = await ctx.git.commitFiles(
    branchName,
    [{ path: metaPath, content: serializeCanonical(existingMeta) }],
    `contentrain: ${status} ${entryIds.length} entries in ${modelId}\n\nCo-Authored-By: ${userEmail}`,
    BOT_AUTHOR,
  )

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}

/**
 * Copy content from one locale to another for a model.
 * Does NOT overwrite existing target content.
 */
export async function copyLocale(
  ctx: EngineInternalContext,
  modelId: string,
  fromLocale: string,
  toLocale: string,
  userEmail: string,
): Promise<WriteResult> {
  await ctx.ensureContentBranch()

  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await ctx.git.readFile(modelPath, CONTENT_BRANCH)) as ModelDefinition

  if (!modelDef.i18n) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
      diff: [],
      validation: { valid: false, errors: [{ field: '', message: 'Model does not support i18n', severity: 'error' as const }] },
    }
  }

  // Read source content
  const sourcePath = resolveContentPath(ctx.pathCtx, modelDef, fromLocale)
  let sourceContent: string
  try {
    sourceContent = await ctx.git.readFile(sourcePath, CONTENT_BRANCH)
  }
  catch {
    return {
      branch: '',
      commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
      diff: [],
      validation: { valid: false, errors: [{ field: '', message: `Source locale "${fromLocale}" not found`, severity: 'error' as const }] },
    }
  }

  // Check if target already exists
  const targetPath = resolveContentPath(ctx.pathCtx, modelDef, toLocale)
  try {
    const existing = await ctx.git.readFile(targetPath, CONTENT_BRANCH)
    if (existing && existing.trim().length > 2) {
      return {
        branch: '',
        commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
        diff: [],
        validation: { valid: false, errors: [{ field: '', message: `Target locale "${toLocale}" already has content. Delete it first to overwrite.`, severity: 'error' as const }] },
      }
    }
  }
  catch { /* target doesn't exist — good */ }

  // Copy source meta too
  const sourceMetaPath = resolveMetaPath(ctx.pathCtx, modelDef, fromLocale)
  let metaContent = '{}\n'
  try {
    metaContent = await ctx.git.readFile(sourceMetaPath, CONTENT_BRANCH)
  }
  catch { /* no meta */ }
  const targetMetaPath = resolveMetaPath(ctx.pathCtx, modelDef, toLocale)

  // Context update
  const contextPath = resolveContextPath(ctx.pathCtx)
  const projectInfo = await ctx.getProjectInfo(toLocale)
  const contextJson = await buildContextUpdate(ctx, contextPath, { tool: 'copy_locale', model: modelId, locale: toLocale }, projectInfo.modelCount, projectInfo.locales, CONTENT_BRANCH)

  const branchName = generateBranchName('content', modelId)
  await ctx.git.createBranch(branchName, CONTENT_BRANCH)

  const message = `contentrain: copy ${modelId} from ${fromLocale} to ${toLocale}\n\nCo-Authored-By: ${userEmail}`
  const commit = await ctx.git.commitFiles(
    branchName,
    [
      { path: targetPath, content: sourceContent },
      { path: targetMetaPath, content: metaContent },
      { path: contextPath, content: contextJson },
    ],
    message,
    BOT_AUTHOR,
  )

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}
