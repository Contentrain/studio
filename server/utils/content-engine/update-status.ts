import type { EntryMeta, FileChange, ModelDefinition } from '@contentrain/types'
import { canonicalStringify, CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH } from '@contentrain/types'
import { buildContextChange } from '@contentrain/mcp/core/context'
import { OverlayReader } from '@contentrain/mcp/core/overlay-reader'
import type { EngineInternalContext, WriteResult } from './types'
import { BOT_AUTHOR, CONTENT_BRANCH } from './types'
import { pinReaderToContentrain, createFeatureBranch } from './helpers'

/**
 * Update entry status (draft / published / archived). Meta-only change —
 * no MCP plan helper covers this; Studio builds the `FileChange` itself
 * and commits atomically via `applyPlan`.
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

  const reader = pinReaderToContentrain(ctx.git)

  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await reader.readFile(modelPath)) as ModelDefinition
  const metaPath = resolveMetaPath(ctx.pathCtx, modelDef, locale)

  let existingMeta: Record<string, EntryMeta> = {}
  try {
    existingMeta = JSON.parse(await reader.readFile(metaPath)) as Record<string, EntryMeta>
  }
  catch { /* no meta */ }

  for (const entryId of entryIds) {
    existingMeta[entryId] = {
      ...(existingMeta[entryId] ?? {}),
      status,
      updated_by: userEmail,
    } as EntryMeta
  }

  const metaChange: FileChange = { path: metaPath, content: canonicalStringify(existingMeta) }

  const overlay = new OverlayReader(reader, [metaChange])
  const contextChange = await buildContextChange(
    overlay,
    { tool: 'update_status', model: modelId, locale, entries: entryIds },
    'mcp-studio',
  )

  const allChanges: FileChange[] = [metaChange, contextChange]
    .toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId, locale)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: ${status} ${entryIds.length} entries in ${modelId}\n\nCo-Authored-By: ${userEmail}`,
    author: BOT_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}

/**
 * Copy content from one locale to another. Does NOT overwrite existing
 * target content. Studio-specific — no MCP plan helper.
 */
export async function copyLocale(
  ctx: EngineInternalContext,
  modelId: string,
  fromLocale: string,
  toLocale: string,
  userEmail: string,
): Promise<WriteResult> {
  await ctx.ensureContentBranch()

  const reader = pinReaderToContentrain(ctx.git)

  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await reader.readFile(modelPath)) as ModelDefinition

  if (!modelDef.i18n) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
      diff: [],
      validation: { valid: false, errors: [{ field: '', message: 'Model does not support i18n', severity: 'error' as const }] },
    }
  }

  const sourcePath = resolveContentPath(ctx.pathCtx, modelDef, fromLocale)
  let sourceContent: string
  try {
    sourceContent = await reader.readFile(sourcePath)
  }
  catch {
    return {
      branch: '',
      commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
      diff: [],
      validation: { valid: false, errors: [{ field: '', message: `Source locale "${fromLocale}" not found`, severity: 'error' as const }] },
    }
  }

  const targetPath = resolveContentPath(ctx.pathCtx, modelDef, toLocale)
  try {
    const existing = await reader.readFile(targetPath)
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

  const sourceMetaPath = resolveMetaPath(ctx.pathCtx, modelDef, fromLocale)
  let metaContent = '{}\n'
  try {
    metaContent = await reader.readFile(sourceMetaPath)
  }
  catch { /* no meta */ }
  const targetMetaPath = resolveMetaPath(ctx.pathCtx, modelDef, toLocale)

  const copyChanges: FileChange[] = [
    { path: targetPath, content: sourceContent },
    { path: targetMetaPath, content: metaContent },
  ]

  const overlay = new OverlayReader(reader, copyChanges)
  const contextChange = await buildContextChange(
    overlay,
    { tool: 'copy_locale', model: modelId, locale: toLocale },
    'mcp-studio',
  )

  const allChanges: FileChange[] = [...copyChanges, contextChange]
    .toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: copy ${modelId} from ${fromLocale} to ${toLocale}\n\nCo-Authored-By: ${userEmail}`,
    author: BOT_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}
