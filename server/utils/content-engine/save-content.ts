import type { ModelDefinition, ValidationResult, EntryMeta } from '@contentrain/types'
import type { ValidationContext } from '../content-validation'
import type { EngineInternalContext, WriteResult } from './types'
import { BOT_AUTHOR, CONTENT_BRANCH } from './types'
import { buildContextUpdate, generateBranchName, toObjectMap } from './helpers'

/**
 * Save content for a model (create or update entries).
 * Creates a cr/* branch from contentrain, commits changes, returns diff.
 */
export async function saveContent(
  ctx: EngineInternalContext,
  modelId: string,
  locale: string,
  data: Record<string, unknown>,
  userEmail: string,
  options?: { autoPublish?: boolean },
): Promise<WriteResult> {
  // 0. Ensure contentrain branch exists + synced before any reads
  await ctx.ensureContentBranch()

  // 1. Load model definition (from contentrain — SSOT)
  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await ctx.git.readFile(modelPath, CONTENT_BRANCH)) as ModelDefinition

  // 2. Read existing content for validation context (unique checks)
  const fields = modelDef.fields ?? {}
  let existingForValidation: Record<string, Record<string, unknown>> = {}
  if (modelDef.kind === 'collection') {
    try {
      const rawExisting = JSON.parse(await ctx.git.readFile(resolveContentPath(ctx.pathCtx, modelDef, locale), CONTENT_BRANCH))
      existingForValidation = toObjectMap(rawExisting) as Record<string, Record<string, unknown>>
    }
    catch { /* no existing content */ }
  }

  // 3. Validate
  let validation: ValidationResult = { valid: true, errors: [] }

  if (modelDef.kind === 'collection') {
    const normalizedData = toObjectMap(data)
    // Build merged entries map for unique validation
    const mergedEntries = { ...existingForValidation }
    for (const [eid, edata] of Object.entries(normalizedData)) {
      mergedEntries[eid] = { ...(mergedEntries[eid] as Record<string, unknown> ?? {}), ...(edata as Record<string, unknown>) }
    }

    for (const entryId of Object.keys(normalizedData)) {
      const valCtx: ValidationContext = {
        allEntries: mergedEntries,
        currentEntryId: entryId,
      }
      // Validate the merged entry (not partial) so required fields from existing content pass
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
    // Merge with existing before validating singleton too
    let existingSingleton: Record<string, unknown> = {}
    try {
      existingSingleton = JSON.parse(await ctx.git.readFile(resolveContentPath(ctx.pathCtx, modelDef, locale), CONTENT_BRANCH)) as Record<string, unknown>
    }
    catch { /* no existing */ }
    const mergedSingleton = { ...existingSingleton, ...data }
    validation = validateContent(mergedSingleton, fields, modelId, locale)
  }
  // Dictionary: no field-level validation (free-form key-value)

  if (!validation.valid) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
      diff: [],
      validation,
    }
  }

  // 4. Read existing content
  const contentPath = resolveContentPath(ctx.pathCtx, modelDef, locale)
  let existingContent: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(await ctx.git.readFile(contentPath, CONTENT_BRANCH))
    existingContent = modelDef.kind === 'collection' ? toObjectMap(raw) : (raw as Record<string, unknown>)
  }
  catch {
    // File doesn't exist yet — creating new
  }

  // 5. Merge data (always merge — never replace)
  let finalContent: unknown
  if (modelDef.kind === 'collection') {
    const normalizedData = toObjectMap(data)
    const merged = { ...existingContent }
    for (const [entryId, entryData] of Object.entries(normalizedData)) {
      const existing = merged[entryId]
      if (existing && typeof existing === 'object' && typeof entryData === 'object') {
        merged[entryId] = { ...(existing as Record<string, unknown>), ...(entryData as Record<string, unknown>) }
      }
      else {
        merged[entryId] = entryData
      }
    }
    finalContent = merged
  }
  else if (modelDef.kind === 'dictionary') {
    for (const [key, val] of Object.entries(data)) {
      if (typeof val !== 'string') {
        return {
          branch: '',
          commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
          diff: [],
          validation: { valid: false, errors: [{ field: key, message: `Dictionary value for "${key}" must be a string, got ${typeof val}`, severity: 'error' as const }] },
        }
      }
    }
    finalContent = { ...existingContent, ...data }
  }
  else {
    finalContent = { ...existingContent, ...data }
  }

  // 6. Serialize to canonical JSON
  const serialized = serializeCanonical(
    finalContent,
    modelDef.kind !== 'dictionary' ? fields : undefined,
  )

  // 7. Build meta file
  const metaPath = resolveMetaPath(ctx.pathCtx, modelDef, locale)
  let existingMeta: Record<string, unknown> = {}
  try {
    existingMeta = JSON.parse(await ctx.git.readFile(metaPath, CONTENT_BRANCH)) as Record<string, unknown>
  }
  catch { /* no existing meta */ }

  const defaultStatus = options?.autoPublish ? 'published' : 'draft'

  let updatedMeta: unknown
  if (modelDef.kind === 'collection') {
    const metaMap = { ...existingMeta } as Record<string, EntryMeta>
    const normalizedData = toObjectMap(data)
    for (const entryId of Object.keys(normalizedData)) {
      const existingStatus = metaMap[entryId]?.status
      metaMap[entryId] = {
        ...(metaMap[entryId] ?? {}),
        status: options?.autoPublish ? 'published' : (existingStatus ?? defaultStatus),
        source: 'agent',
        updated_by: userEmail,
      } as EntryMeta
    }
    updatedMeta = metaMap
  }
  else {
    const existingStatus = (existingMeta as unknown as EntryMeta).status
    updatedMeta = {
      ...existingMeta,
      status: options?.autoPublish ? 'published' : (existingStatus ?? defaultStatus),
      source: 'agent' as const,
      updated_by: userEmail,
    }
  }

  // 8. Build context.json update
  const contextPath = resolveContextPath(ctx.pathCtx)
  const entryIds = modelDef.kind === 'collection' ? Object.keys(toObjectMap(data)) : undefined
  const projectInfo = await ctx.getProjectInfo(locale)
  const contextJson = await buildContextUpdate(ctx, contextPath, { tool: 'save_content', model: modelId, locale, entries: entryIds }, projectInfo.modelCount, projectInfo.locales, CONTENT_BRANCH)

  // 9. Create feature branch from contentrain
  const branchName = generateBranchName('content', modelId, locale)
  await ctx.git.createBranch(branchName, CONTENT_BRANCH)

  // 10. Commit content + meta + context
  const message = `contentrain: save ${modelId} [${locale}]\n\nCo-Authored-By: ${userEmail}`
  const commit = await ctx.git.commitFiles(
    branchName,
    [
      { path: contentPath, content: serialized },
      { path: metaPath, content: serializeCanonical(updatedMeta) },
      { path: contextPath, content: contextJson },
    ],
    message,
    BOT_AUTHOR,
  )

  // 11. Get diff (against contentrain, not default)
  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)

  return { branch: branchName, commit, diff, validation }
}
