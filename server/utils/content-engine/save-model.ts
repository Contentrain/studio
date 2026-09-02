import type { ContentrainConfig, FileChange, ModelDefinition, RepoReader } from '@contentrain/types'
import { CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH, parseMarkdownFrontmatter } from '@contentrain/types'
import { planModelSave } from '@contentrain/mcp/core/ops'
import { collectFieldPaths, legacyFieldNames } from '@contentrain/mcp/core/model-manager'
import type { EngineInternalContext, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
import { pinReaderToContentrain, createFeatureBranch, toObjectMap } from './helpers'
import type { BreakingModelChange, FieldUsage, ModelChangeSummary, ModelSaveOptions } from './model-merge'
import {
  breakingCandidates,
  describeBreakingChange,
  hasContentValue,
  mergeModelDefinition,
  summarizeModelChange,
  validateTitleField,
  withAffectedEntries,
} from './model-merge'

export interface ModelWriteResult extends WriteResult {
  /** What the save did to the field list; absent when the save was refused. */
  modelChange?: ModelChangeSummary
  /** Why the save was refused, when it was refused for content's sake. */
  breakingChanges?: BreakingModelChange[]
  /** What the save tolerated — a legacy field name kept as-is — so the caller can say so. */
  warnings?: string[]
}

function refused(errors: Array<{ field: string, message: string }>, extra: Partial<ModelWriteResult> = {}): ModelWriteResult {
  return {
    branch: '',
    commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
    diff: [],
    validation: {
      valid: false,
      errors: errors.map(e => ({ ...e, severity: 'error' as const })),
    },
    ...extra,
  }
}

/**
 * How many entries still hold a value for each field, read from
 * `contentrain` across the model's locales. Only called when a save has a
 * candidate breaking change, so the common add-a-field save never pays for
 * it. An entry present in several locales counts once.
 */
async function countFieldUsage(
  reader: RepoReader,
  pathCtx: EngineInternalContext['pathCtx'],
  model: ModelDefinition,
  config: ContentrainConfig | null,
): Promise<FieldUsage> {
  const defaultLocale = config?.locales?.default ?? 'en'
  const locales = model.i18n ? (config?.locales?.supported?.length ? config.locales.supported : [defaultLocale]) : [defaultLocale]
  const entryIds = new Set<string>()
  const byField = new Map<string, Set<string>>()

  const record = (entryId: string, data: Record<string, unknown>) => {
    entryIds.add(entryId)
    for (const [fieldId, value] of Object.entries(data)) {
      if (!hasContentValue(value)) continue
      const set = byField.get(fieldId) ?? new Set<string>()
      set.add(entryId)
      byField.set(fieldId, set)
    }
  }

  for (const locale of locales) {
    try {
      if (model.kind === 'collection') {
        const raw = JSON.parse(await reader.readFile(resolveContentPath(pathCtx, model, locale)))
        for (const [id, entry] of Object.entries(toObjectMap(raw))) {
          if (entry && typeof entry === 'object') record(id, entry as Record<string, unknown>)
        }
      }
      else if (model.kind === 'singleton') {
        const raw = JSON.parse(await reader.readFile(resolveContentPath(pathCtx, model, locale)))
        if (raw && typeof raw === 'object') record('singleton', raw as Record<string, unknown>)
      }
      else if (model.kind === 'document') {
        const names = await reader.listDirectory(resolveContentPath(pathCtx, model, locale))
        for (const name of names) {
          const slug = name.replace(/\.md$/, '')
          try {
            const parsed = parseMarkdownFrontmatter(await reader.readFile(resolveContentPath(pathCtx, model, locale, slug)))
            record(slug, (parsed.frontmatter ?? {}) as Record<string, unknown>)
          }
          catch { /* not a document, or missing in this locale */ }
        }
      }
    }
    catch { /* no content for this locale */ }
  }

  return {
    entries: entryIds.size,
    byField: Object.fromEntries([...byField].map(([fieldId, ids]) => [fieldId, ids.size])),
  }
}

/**
 * Save a model definition (create or update).
 *
 * An update MERGES with the definition on `contentrain`: fields the caller
 * omits are kept, fields it sends are merged property by property, and only
 * `removeFields` drops one. That is the contract the tool description gives
 * the agent, and the opposite of what happened on iterum, where a one-field
 * payload replaced a 39-field model and auto-merged to `main`.
 *
 * A change that would orphan or invalidate content — a removed or retyped
 * field with entries still carrying it, a changed kind or i18n with entries
 * stored under the old layout — is refused with the affected count unless
 * the caller passes `allowBreaking`. Studio's own schema validation runs on
 * the merged result; file assembly is `planModelSave` (canonical
 * `.contentrain/models/{id}.json`). `context.json` is regenerated on
 * `contentrain` post-merge (MCP 1.5.0 model), not committed here.
 */
export async function saveModel(
  ctx: EngineInternalContext,
  definition: ModelDefinition,
  userEmail: string,
  options: ModelSaveOptions = {},
): Promise<ModelWriteResult> {
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

  // The definition on `contentrain` is what a partial save merges into. A
  // model whose file is missing or unreadable is a new model.
  let existing: ModelDefinition | null = null
  try {
    existing = JSON.parse(await reader.readFile(resolveModelPath(ctx.pathCtx, definition.id))) as ModelDefinition
  }
  catch { /* new model */ }

  const next = existing ? mergeModelDefinition(existing, definition, options.removeFields ?? []) : definition

  const titleFieldError = validateTitleField(next)
  if (titleFieldError) return refused([{ field: 'title_field', message: titleFieldError }])

  // Field names are snake_case. A name the model already had before the rule
  // is kept — refusing it would make the whole model read-only, when a
  // one-line title_field correction never touches the field — and reported,
  // the same tolerance MCP's contentrain_model_save applies (ai #116). A NEW
  // field is held to the rule, so Studio cannot mint the legacy names the
  // MCP validator then lists as notices.
  const existingPaths = existing ? collectFieldPaths(existing.fields) : new Set<string>()
  const legacy = legacyFieldNames(next.fields)
  const invalidNew = legacy.filter(path => !existingPaths.has(path))
  if (invalidNew.length > 0) {
    return refused(invalidNew.map(path => ({
      field: path,
      message: `Field "${path}": invalid name — must be snake_case starting with a letter`,
    })))
  }
  const warnings = legacy.map(path =>
    `Field "${path}": legacy name is not snake_case — kept because the model already has it. New fields must be snake_case. Renaming it also means renaming its content keys in every locale.`,
  )

  const schemaWarnings = validateModelDefinition(next, config, existingModelIds)
  const criticalErrors = schemaWarnings.filter(w => w.severity === 'critical' || w.severity === 'error')
  if (criticalErrors.length > 0) {
    return refused(criticalErrors.map(w => ({ field: w.field ?? '', message: w.message })))
  }

  if (existing && !options.allowBreaking) {
    const candidates = breakingCandidates(existing, next)
    if (candidates.length > 0) {
      const usage = await countFieldUsage(reader, ctx.pathCtx, existing, config)
      const breaking = withAffectedEntries(candidates, usage)
      if (breaking.length > 0) {
        return refused(
          breaking.map(c => ({ field: c.field ?? '', message: describeBreakingChange(c) })),
          { breakingChanges: breaking },
        )
      }
    }
  }

  let plan
  try {
    plan = await planModelSave(reader, { model: next })
  }
  catch (err) {
    return refused([{ field: '', message: err instanceof Error ? err.message : String(err) }])
  }

  const allChanges: FileChange[] = [...plan.changes]
    .toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'model', next.id)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: save model ${next.id}\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return {
    branch: branchName,
    commit,
    diff,
    validation: { valid: true, errors: [] },
    modelChange: summarizeModelChange(existing, next),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
