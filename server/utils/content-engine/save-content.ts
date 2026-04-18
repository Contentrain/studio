import type { ContentrainConfig, FileChange, ModelDefinition, ValidationResult, Vocabulary } from '@contentrain/types'
import { CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH } from '@contentrain/types'
import { buildContextChange } from '@contentrain/mcp/core/context'
import { planContentSave } from '@contentrain/mcp/core/ops'
import { OverlayReader } from '@contentrain/mcp/core/overlay-reader'
import type { ValidationContext } from '../content-validation'
import type { EngineInternalContext, WriteResult } from './types'
import { BOT_AUTHOR, CONTENT_BRANCH } from './types'
import {
  applyStudioMetaOverrides,
  pinReaderToContentrain,
  createFeatureBranch,
  shapeEntriesForSave,
  toObjectMap,
} from './helpers'

/**
 * Save content for a model (create or update entries).
 *
 * Delegates file assembly (paths, canonical serialization, merge of
 * new entries with existing on-disk content) to
 * `@contentrain/mcp/core/ops:planContentSave`; Studio keeps:
 *
 * - field-level validation (S3 swaps this for MCP's validator too)
 * - meta override (autoPublish + preserved status + user email)
 * - feature-branch lifecycle (`cr/*` name generation, health check)
 * - commit + diff bookkeeping for the `WriteResult` return shape
 *
 * `OverlayReader` is wrapped around the pinned reader so the committed
 * `context.json` reflects post-commit stats (see `.internal/refactor/
 * 02-studio-handoff.md` Faz S2.1 — Phase 10 tuzakları).
 */
export async function saveContent(
  ctx: EngineInternalContext,
  modelId: string,
  locale: string,
  data: Record<string, unknown>,
  userEmail: string,
  options?: { autoPublish?: boolean },
): Promise<WriteResult> {
  await ctx.ensureContentBranch()

  const reader = pinReaderToContentrain(ctx.git)

  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await reader.readFile(modelPath)) as ModelDefinition

  const fields = modelDef.fields ?? {}
  let validation: ValidationResult = { valid: true, errors: [] }

  if (modelDef.kind === 'collection') {
    let existingForValidation: Record<string, Record<string, unknown>> = {}
    try {
      const raw = JSON.parse(await reader.readFile(resolveContentPath(ctx.pathCtx, modelDef, locale)))
      existingForValidation = toObjectMap(raw) as Record<string, Record<string, unknown>>
    }
    catch { /* no existing content */ }

    const normalizedData = toObjectMap(data)
    const mergedEntries = { ...existingForValidation }
    for (const [eid, edata] of Object.entries(normalizedData)) {
      mergedEntries[eid] = {
        ...(mergedEntries[eid] as Record<string, unknown> ?? {}),
        ...(edata as Record<string, unknown>),
      }
    }

    for (const entryId of Object.keys(normalizedData)) {
      const valCtx: ValidationContext = {
        allEntries: mergedEntries,
        currentEntryId: entryId,
      }
      const entryValidation = validateContent(
        mergedEntries[entryId] as Record<string, unknown>,
        fields,
        modelId,
        locale,
        entryId,
        valCtx,
      )
      validation.errors.push(...entryValidation.errors)
      if (!entryValidation.valid) validation.valid = false
    }
  }
  else if (modelDef.kind === 'singleton') {
    let existingSingleton: Record<string, unknown> = {}
    try {
      existingSingleton = JSON.parse(await reader.readFile(resolveContentPath(ctx.pathCtx, modelDef, locale))) as Record<string, unknown>
    }
    catch { /* no existing */ }
    const mergedSingleton = { ...existingSingleton, ...data }
    validation = validateContent(mergedSingleton, fields, modelId, locale)
  }
  else if (modelDef.kind === 'dictionary') {
    for (const [key, val] of Object.entries(data)) {
      if (typeof val !== 'string') {
        return {
          branch: '',
          commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
          diff: [],
          validation: {
            valid: false,
            errors: [{
              field: key,
              message: `Dictionary value for "${key}" must be a string, got ${typeof val}`,
              severity: 'error' as const,
            }],
          },
        }
      }
    }
  }

  if (!validation.valid) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
      diff: [],
      validation,
    }
  }

  const config = JSON.parse(await reader.readFile(resolveConfigPath(ctx.pathCtx))) as ContentrainConfig
  let vocabulary: Vocabulary | null = null
  try {
    vocabulary = JSON.parse(await reader.readFile(resolveVocabularyPath(ctx.pathCtx))) as Vocabulary
  }
  catch { /* no vocabulary */ }

  const entries = shapeEntriesForSave(modelDef, data, locale)

  let plan
  try {
    plan = await planContentSave(reader, { model: modelDef, entries, config, vocabulary })
  }
  catch (err) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
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

  const touchedIds = modelDef.kind === 'collection'
    ? plan.result.map(r => r.id).filter((id): id is string => typeof id === 'string')
    : []

  const metaPath = resolveMetaPath(ctx.pathCtx, modelDef, locale)
  const patchedChanges = await applyStudioMetaOverrides({
    planChanges: plan.changes,
    metaPath,
    model: modelDef,
    touchedIds,
    reader,
    autoPublish: options?.autoPublish ?? false,
    userEmail,
  })

  const overlay = new OverlayReader(reader, patchedChanges)
  const contextChange = await buildContextChange(
    overlay,
    {
      tool: 'save_content',
      model: modelId,
      locale,
      entries: modelDef.kind === 'collection' ? touchedIds : undefined,
    },
    'mcp-studio',
  )

  const allChanges: FileChange[] = [...patchedChanges, contextChange]
    .toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId, locale)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: save ${modelId} [${locale}]\n\nCo-Authored-By: ${userEmail}`,
    author: BOT_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)

  return { branch: branchName, commit, diff, validation }
}
