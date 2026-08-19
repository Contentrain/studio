import type { ContentrainConfig, FileChange, ModelDefinition, Vocabulary } from '@contentrain/types'
import { CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH, parseMarkdownFrontmatter, validateSlug } from '@contentrain/types'
import { planContentSave } from '@contentrain/mcp/core/ops'
import type { EngineInternalContext, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
import { applyStudioMetaOverrides, pinReaderToContentrain, createFeatureBranch, planMatchesCurrent } from './helpers'
import { rewriteEntryMedia, rewriteMarkdownMedia } from '../media-rewrite'

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

  // Normalize media-storage paths to absolute delivery URLs in both the
  // frontmatter (schema-driven) and the markdown body (image/link targets), so
  // the committed document carries ready-to-use URLs for any consumer.
  if (ctx.projectId) {
    frontmatter = rewriteEntryMedia(frontmatter, fields, ctx.projectId)
    body = rewriteMarkdownMedia(body, ctx.projectId)
  }

  // Merge with the existing entry on disk so a partial update — a single
  // changed frontmatter field, or an edit that doesn't touch the body —
  // never drops untouched fields or wipes the body. This mirrors the
  // read-then-merge behaviour `saveContent` already applies to collections
  // and singletons; documents were the only kind missing it, which is why a
  // cover-image-only agent edit lost the body and tripped "author is
  // required", and a manual field edit hit "Required field is missing".
  let existingFrontmatter: Record<string, unknown> = {}
  let existingBody = ''
  try {
    const raw = await reader.readFile(resolveContentPath(ctx.pathCtx, modelDef, locale, safeSlug))
    const parsed = parseMarkdownFrontmatter(raw)
    existingFrontmatter = (parsed.frontmatter ?? {}) as Record<string, unknown>
    existingBody = parsed.body ?? ''
  }
  catch { /* new document — nothing to merge */ }

  const mergedFrontmatter = { ...existingFrontmatter, ...frontmatter }
  // Preserve the existing body when the caller sends an empty one (the common
  // case for a frontmatter-only edit). An intentional clear is rare and not
  // worth the risk of silent content loss.
  const mergedBody = body.trim() ? body : existingBody

  // Documents receive `slug` as a dedicated argument, not inside
  // `frontmatter` — but a schema may declare `slug` as a (required,
  // unique) field. Fold it into the validated object (the same shape
  // persisted below) when the model knows about it, so a caller that
  // passes slug separately — as the tool contract intends — doesn't trip
  // a false "required field is missing" error. Schemas that don't model
  // slug are validated untouched.
  const dataToValidate = 'slug' in fields ? { ...mergedFrontmatter, slug: safeSlug } : mergedFrontmatter
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
  const entryData = { ...mergedFrontmatter, slug: safeSlug, body: mergedBody }

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

  const metaPath = resolveMetaPath(ctx.pathCtx, modelDef, locale, config.locales?.default ?? 'en', safeSlug)
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

  // Byte-identical plan → no-op; skip the branch/commit/merge cycle
  // (same short-circuit as saveContent).
  if (await planMatchesCurrent(reader, allChanges)) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
      diff: [],
      validation,
      unchanged: true,
    }
  }

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
