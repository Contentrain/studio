import type { ContentrainConfig, FileChange, ModelDefinition, ValidationResult, Vocabulary } from '@contentrain/types'
import { CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH } from '@contentrain/types'
import { planContentSave } from '@contentrain/mcp/core/ops'
import type { ValidationContext } from '../content-validation'
import type { EngineInternalContext, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
import {
  applyStudioMetaOverrides,
  pinReaderToContentrain,
  createFeatureBranch,
  shapeEntriesForSave,
  toObjectMap,
} from './helpers'
import { normalizeModelContentMedia } from '../media-rewrite'
import { saveDocument } from './save-document'

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
 * `context.json` is not committed here — it is regenerated on
 * `contentrain` post-merge (MCP 1.5.0 model; see `branch-ops.ts`).
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

  // Documents reach this route addressed as `{ [slug]: { ...fields, body? } }`
  // (entryId = slug), mirroring the collection entry shape. They were never
  // handled here — `shapeEntriesForSave` produced a slug-less entry and
  // `planContentSave` threw "Document entries require a slug". Split the wrapper
  // back into the (slug, frontmatter, body) tuple `saveDocument` expects, which
  // reads + merges with the existing entry so a partial field edit doesn't drop
  // untouched fields or the body. (The agent path calls `saveDocument` directly;
  // only the manual content route reaches documents through here.)
  if (modelDef.kind === 'document') {
    const [first] = Object.entries(data)
    if (!first) {
      return {
        branch: '',
        commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
        diff: [],
        validation: { valid: false, errors: [{ field: '', message: 'Document save requires an entry keyed by its slug', severity: 'error' as const }] },
      }
    }
    const [slug, rawFields] = first
    const docFields = (rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields) ? rawFields : {}) as Record<string, unknown>
    const { body, ...frontmatter } = docFields
    return saveDocument(ctx, modelId, locale, slug, frontmatter, typeof body === 'string' ? body : '', userEmail, options)
  }

  // Normalize media-storage paths (`media/...`) in image/video/file fields to
  // absolute delivery URLs before anything else, so the git-committed value is
  // a ready-to-use URL for every consumer (CDN, local-mode bundle, raw markdown,
  // mobile app) with no SDK or integration code. Returns a fresh object — the
  // caller's `data` (used elsewhere, e.g. route-level usage tracking) is intact.
  if (ctx.projectId)
    data = normalizeModelContentMedia(modelDef, data, ctx.projectId) as Record<string, unknown>

  const fields = modelDef.fields ?? {}
  let validation: ValidationResult = { valid: true, errors: [] }

  // The save_content contract (and the agent-facing tool description) is
  // "MERGES with existing data — only send changed fields." Studio's
  // validation already merges partial input with the on-disk entry, but
  // MCP's `planContentSave` REPLACES an entry wholesale (`existing[id] =
  // entry.data`). Without carrying the merge into the write, a partial
  // field edit validates green against the merged entry yet persists only
  // the sent fields — silently dropping every untouched field. We build
  // the field-merged payload here and hand THAT to the writer so the
  // contract holds (matches the document path, which already merges).
  let dataForWrite: Record<string, unknown> = data

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

    // Persist the merged entries for only the touched IDs — never the
    // untouched siblings (that would needlessly rewrite + re-stamp them).
    const mergedForWrite: Record<string, unknown> = {}
    for (const entryId of Object.keys(normalizedData)) {
      mergedForWrite[entryId] = mergedEntries[entryId]
    }
    dataForWrite = mergedForWrite
  }
  else if (modelDef.kind === 'singleton') {
    let existingSingleton: Record<string, unknown> = {}
    try {
      existingSingleton = JSON.parse(await reader.readFile(resolveContentPath(ctx.pathCtx, modelDef, locale))) as Record<string, unknown>
    }
    catch { /* no existing */ }
    const mergedSingleton = { ...existingSingleton, ...data }
    validation = validateContent(mergedSingleton, fields, modelId, locale)
    dataForWrite = mergedSingleton
  }
  else if (modelDef.kind === 'dictionary') {
    for (const [key, val] of Object.entries(data)) {
      if (typeof val !== 'string') {
        return {
          branch: '',
          commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
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
      commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
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

  const entries = shapeEntriesForSave(modelDef, dataForWrite, locale)

  let plan
  try {
    plan = await planContentSave(reader, { model: modelDef, entries, config, vocabulary })
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

  // context.json is NOT committed on feature branches (MCP 1.5.0 model):
  // it is regenerated deterministically on `contentrain` post-merge so
  // parallel saves cannot conflict on it. See `regenerateContextOnContentrain`
  // in `branch-ops.ts`.
  const allChanges: FileChange[] = [...patchedChanges]
    .toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId, locale)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: save ${modelId} [${locale}]\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)

  return { branch: branchName, commit, diff, validation }
}
