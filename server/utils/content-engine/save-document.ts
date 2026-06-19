import type { ContentrainConfig, FileChange, ModelDefinition, Vocabulary } from '@contentrain/types'
import { CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH, validateSlug } from '@contentrain/types'
import { planContentSave } from '@contentrain/mcp/core/ops'
import type { EngineInternalContext, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
import { applyStudioMetaOverrides, pinReaderToContentrain, createFeatureBranch } from './helpers'

/**
 * Save a document entry (markdown with frontmatter).
 *
 * Delegates markdown serialization + path resolution to
 * `planContentSave` (document kind); Studio overrides meta with its
 * own status + user-email logic. `context.json` is not touched here —
 * it is regenerated on `contentrain` post-merge (MCP 1.5.0 model).
 */
export async function saveDocument(
  ctx: EngineInternalContext,
  modelId: string,
  locale: string,
  slug: string,
  frontmatter: Record<string, unknown>,
  body: string,
  userEmail: string,
  options?: { autoPublish?: boolean },
): Promise<WriteResult> {
  const safeSlug = slug.toLowerCase()
  const slugError = validateSlug(safeSlug)
  if (slugError) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
      diff: [],
      validation: { valid: false, errors: [{ field: 'slug', message: slugError, severity: 'error' as const }] },
    }
  }

  await ctx.ensureContentBranch()

  const reader = pinReaderToContentrain(ctx.git)

  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await reader.readFile(modelPath)) as ModelDefinition

  const fields = modelDef.fields ?? {}
  // Documents receive `slug` as a dedicated argument, not inside
  // `frontmatter` — but a schema may declare `slug` as a (required,
  // unique) field. Fold it into the validated object (the same shape
  // persisted below) when the model knows about it, so a caller that
  // passes slug separately — as the tool contract intends — doesn't trip
  // a false "required field is missing" error. Schemas that don't model
  // slug are validated untouched.
  const dataToValidate = 'slug' in fields ? { ...frontmatter, slug: safeSlug } : frontmatter
  const validation = validateContent(dataToValidate, fields, modelId, locale, safeSlug)
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

  // `planContentSave` for document kind expects frontmatter + body folded
  // into `entry.data` under a `body` key. It strips `body` out before
  // serializing frontmatter, so the final markdown contains frontmatter
  // fields (minus `body`) + the body content.
  const entryData = { ...frontmatter, slug: safeSlug, body }

  let plan
  try {
    plan = await planContentSave(reader, {
      model: modelDef,
      entries: [{ slug: safeSlug, locale, data: entryData }],
      config,
      vocabulary,
    })
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

  const metaPath = resolveMetaPath(ctx.pathCtx, modelDef, locale, safeSlug)
  const patchedChanges = await applyStudioMetaOverrides({
    planChanges: plan.changes,
    metaPath,
    model: modelDef,
    touchedIds: [],
    reader,
    autoPublish: options?.autoPublish ?? false,
    userEmail,
  })

  // context.json is regenerated on `contentrain` post-merge, not committed
  // here (MCP 1.5.0 model — see `branch-ops.ts`).
  const allChanges: FileChange[] = [...patchedChanges]
    .toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId, locale)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: save document ${modelId}/${safeSlug} [${locale}]\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation }
}
