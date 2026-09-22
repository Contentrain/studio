import type { ContentrainConfig, FileChange, ModelDefinition, RepoReader, ValidationResult, Vocabulary } from '@contentrain/types'
import { CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH, parseMarkdownFrontmatter, validateSlug } from '@contentrain/types'
import { planContentSave } from '@contentrain/mcp/core/ops'
import type { EngineInternalContext, SaveOptions, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
import { applyStudioMetaOverrides, openWriteSnapshot, createFeatureBranch, plannedStatuses, planMatchesCurrent, splitEntrySchedule, validateSchedule } from './helpers'
import { rewriteEntryMedia, rewriteMarkdownMedia } from '../media-rewrite'
import { entryModeErrors } from './entry-mode'
import { mergeEntryFields } from './field-merge'
import { planDocumentLocaleFanOut } from './locale-fanout'

/** One document of a save: its slug, the frontmatter fields sent, and the body. */
export interface DocumentInput {
  slug: string
  frontmatter: Record<string, unknown>
  body: string
}

/** The most documents one batch save may write — see `saveDocuments`. */
export const MAX_DOCUMENTS_PER_SAVE = 20

/**
 * Save a document entry (markdown with frontmatter).
 *
 * Delegates markdown serialization + path resolution to
 * `planContentSave` (document kind); Studio overrides meta with its
 * own status + user-email logic. `context.json` is not touched here —
 * it is regenerated on `contentrain` post-merge (MCP 1.5.0 model).
 */
export function saveDocument(
  ctx: EngineInternalContext,
  modelId: string,
  locale: string,
  slug: string,
  frontmatter: Record<string, unknown>,
  body: string,
  userEmail: string,
  options?: SaveOptions,
): Promise<WriteResult> {
  return writeDocuments(ctx, modelId, locale, [{ slug, frontmatter, body }], userEmail, options)
}

/**
 * Save several documents of one model in ONE commit — one branch, one merge.
 *
 * Rewriting a guide's sections used to be one save per section, each with its
 * own branch and merge at ~20–30 s apiece: 10–13 sections took five to six
 * minutes (#292). Every document is planned, merged and validated on its own
 * exactly as a single save would; the batch is all-or-nothing — one invalid
 * document writes none of them.
 */
export function saveDocuments(
  ctx: EngineInternalContext,
  modelId: string,
  locale: string,
  documents: DocumentInput[],
  userEmail: string,
  options?: SaveOptions,
): Promise<WriteResult> {
  if (documents.length === 0 || documents.length > MAX_DOCUMENTS_PER_SAVE) {
    return Promise.resolve(refused({
      valid: false,
      errors: [{ field: '', severity: 'error', message: `A batch save takes 1 to ${MAX_DOCUMENTS_PER_SAVE} documents, got ${documents.length}.` }],
    }))
  }
  return writeDocuments(ctx, modelId, locale, documents, userEmail, options)
}

function refused(validation: ValidationResult): WriteResult {
  return {
    branch: '',
    commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
    diff: [],
    validation,
  }
}

async function writeDocuments(
  ctx: EngineInternalContext,
  modelId: string,
  locale: string,
  documents: DocumentInput[],
  userEmail: string,
  options?: SaveOptions,
): Promise<WriteResult> {
  const scheduleError = validateSchedule(options?.schedule)
  if (scheduleError)
    return refused({ valid: false, errors: [{ field: 'publish_at', message: scheduleError, severity: 'error' as const }] })

  const slugs = documents.map(d => d.slug.toLowerCase())
  const duplicate = slugs.find((slug, i) => slugs.indexOf(slug) !== i)
  if (duplicate)
    return refused({ valid: false, errors: [{ field: 'slug', entry: duplicate, message: 'The same slug appears twice in one save.', severity: 'error' as const }] })
  for (const slug of slugs) {
    const slugError = validateSlug(slug)
    if (slugError) return refused({ valid: false, errors: [{ field: 'slug', entry: slug, message: slugError, severity: 'error' as const }] })
  }

  await ctx.ensureContentBranch()

  const snapshot = options?.snapshot ?? await openWriteSnapshot(ctx.git)
  const reader = snapshot.reader

  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await reader.readFile(modelPath)) as ModelDefinition

  const config = JSON.parse(await reader.readFile(resolveConfigPath(ctx.pathCtx))) as ContentrainConfig
  let vocabulary: Vocabulary | null = null
  try {
    vocabulary = JSON.parse(await reader.readFile(resolveVocabularyPath(ctx.pathCtx))) as Vocabulary
  }
  catch { /* no vocabulary */ }

  const planned: PlannedDocument[] = []
  for (const document of documents) {
    planned.push(await planDocumentWrite({ ctx, reader, modelDef, config, vocabulary, modelId, locale, document, userEmail, options }))
  }

  // All-or-nothing: report every invalid document, write none of them.
  const invalid = planned.filter((p): p is Extract<PlannedDocument, { ok: false }> => !p.ok)
  if (invalid.length > 0)
    return refused({ valid: false, errors: invalid.flatMap(p => p.validation.errors) })
  const ok = planned as Array<Extract<PlannedDocument, { ok: true }>>

  // Documents never share files (content and meta are per slug), so the
  // union of their plans is exact.
  const byPath = new Map<string, FileChange>()
  for (const p of ok) {
    for (const change of p.changes) byPath.set(change.path, change)
  }
  const allChanges = [...byPath.values()].toSorted((a, b) => a.path.localeCompare(b.path))

  const validation: ValidationResult = { valid: true, errors: ok.flatMap(p => p.validation.errors) }
  const entries = {
    created: ok.filter(p => !p.exists).map(p => p.slug),
    updated: ok.filter(p => p.exists).map(p => p.slug),
  }
  const statuses = Object.assign({}, ...ok.map(p => p.statuses)) as Record<string, string>
  const sharedFields = [...new Set(ok.flatMap(p => p.fanOut.fields))]
  const sharedLocales = [...new Set(ok.flatMap(p => p.fanOut.locales))]
  const shared = sharedLocales.length > 0 ? { sharedAcrossLocales: { fields: sharedFields, locales: sharedLocales } } : {}

  // Byte-identical plan → no-op; skip the branch/commit/merge cycle
  // (same short-circuit as saveContent).
  if (await planMatchesCurrent(reader, allChanges)) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
      diff: [],
      validation,
      unchanged: true,
      entries,
      statuses,
    }
  }

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId, locale, snapshot.baseSha)

  const subject = ok.length === 1
    ? `contentrain: save document ${modelId}/${ok[0]!.slug} [${locale}]`
    : `contentrain: save ${ok.length} documents in ${modelId} [${locale}]`
  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `${subject}\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return {
    branch: branchName,
    commit,
    diff,
    validation,
    ...shared,
    entries,
    statuses,
  }
}

type PlannedDocument
  = | { ok: false, validation: ValidationResult }
    | {
      ok: true
      slug: string
      exists: boolean
      changes: FileChange[]
      validation: ValidationResult
      fanOut: { fields: string[], locales: string[] }
      statuses: Record<string, string>
    }

/** Plan one document's files — the per-document half of a (batch) save. */
async function planDocumentWrite(args: {
  ctx: EngineInternalContext
  reader: RepoReader
  modelDef: ModelDefinition
  config: ContentrainConfig
  vocabulary: Vocabulary | null
  modelId: string
  locale: string
  document: DocumentInput
  userEmail: string
  options?: SaveOptions
}): Promise<PlannedDocument> {
  const { ctx, reader, modelDef, config, vocabulary, modelId, locale, userEmail, options } = args
  const safeSlug = args.document.slug.toLowerCase()
  let { frontmatter, body } = args.document

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
  let documentExists = false
  try {
    const raw = await reader.readFile(resolveContentPath(ctx.pathCtx, modelDef, locale, safeSlug))
    const parsed = parseMarkdownFrontmatter(raw)
    existingFrontmatter = (parsed.frontmatter ?? {}) as Record<string, unknown>
    existingBody = parsed.body ?? ''
    documentExists = true
  }
  catch { /* new document — nothing to merge */ }

  // Scheduling rides on the entry, never in the frontmatter — the leak an
  // older content_save left behind is exactly what MCP's validator now warns
  // about. Lifted here so the merged frontmatter never carries it.
  const lifted = splitEntrySchedule(modelDef, frontmatter, options?.schedule)
  frontmatter = lifted.data
  const mergedFrontmatter = mergeEntryFields(existingFrontmatter, frontmatter, fields)
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
  // Same gate as slug uniqueness: a create that names an existing slug, or an
  // update of a slug that isn't there, is refused rather than merged (#298).
  const modeErrors = entryModeErrors(options?.mode, [safeSlug], () => documentExists, { model: modelId, locale })
  if (modeErrors.length > 0) {
    validation.errors.push(...modeErrors)
    validation.valid = false
  }
  if (!validation.valid) return { ok: false, validation }

  // `planContentSave` for document kind expects frontmatter + body folded
  // into `entry.data` under a `body` key. It strips `body` out before
  // serializing frontmatter, so the final markdown contains frontmatter
  // fields (minus `body`) + the body content.
  const entryData = { ...mergedFrontmatter, slug: safeSlug, body: mergedBody }

  // A cover image or a related entry carries no language: carry it into the
  // other locales' documents, each keeping its own body (see save-content).
  const fanOut = await planDocumentLocaleFanOut({ reader, pathCtx: ctx.pathCtx, model: modelDef, config, locale, slug: safeSlug, frontmatter })

  let plan
  try {
    plan = await planContentSave(reader, {
      model: modelDef,
      entries: [{ slug: safeSlug, locale, data: entryData, ...lifted.schedule }, ...fanOut.entries],
      config,
      vocabulary,
    })
  }
  catch (err) {
    return {
      ok: false,
      validation: {
        valid: false,
        errors: [{
          field: '',
          entry: safeSlug,
          message: err instanceof Error ? err.message : String(err),
          severity: 'error' as const,
        }],
      },
    }
  }

  const defaultLocale = config.locales?.default ?? 'en'
  let patchedChanges = plan.changes
  for (const writtenLocale of [locale, ...fanOut.locales]) {
    patchedChanges = await applyStudioMetaOverrides({
      planChanges: patchedChanges,
      metaPath: resolveMetaPath(ctx.pathCtx, modelDef, writtenLocale, defaultLocale, safeSlug),
      model: modelDef,
      touchedIds: [],
      reader,
      autoPublish: options?.autoPublish ?? false,
      userEmail,
      // Only the addressed locale's document takes a requested status; the
      // fan-out locales receive shared media/relation values, not a publish.
      ...(writtenLocale === locale && options?.status ? { status: options.status } : {}),
    })
  }

  return {
    ok: true,
    slug: safeSlug,
    exists: documentExists,
    changes: patchedChanges,
    validation,
    fanOut: { fields: fanOut.fields, locales: fanOut.locales },
    statuses: plannedStatuses(patchedChanges, resolveMetaPath(ctx.pathCtx, modelDef, locale, defaultLocale, safeSlug), modelDef.kind, [], safeSlug),
  }
}
