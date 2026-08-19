import type { ContentrainConfig, EntryMeta, FileChange, ModelDefinition, RepoReader } from '@contentrain/types'
import { canonicalStringify, CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH, validateSlug } from '@contentrain/types'
import type { EngineInternalContext, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
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

  // A non-i18n model keeps ONE meta record, pinned to the default locale. A
  // status write must target that exact path — otherwise it lands at the
  // caller's locale and the readers (brain/CDN, normalized to default) never
  // see the change. `resolveMetaPath` needs the default locale to do this.
  const config = JSON.parse(await reader.readFile(resolveConfigPath(ctx.pathCtx))) as ContentrainConfig
  const defaultLocale = config.locales?.default ?? 'en'

  // The meta layout differs by kind, so status writes must branch on it too:
  //  - collection: one id-keyed map at `.../{modelId}/{locale}.json`
  //  - document:   one top-level EntryMeta *per slug* at
  //                `.../{modelId}/{slug}/{locale}.json` — each entryId IS a slug
  //  - singleton / dictionary: one top-level EntryMeta at `.../{modelId}/{locale}.json`
  // Treating every kind as a collection (id-keyed map, slug-less meta path)
  // both corrupted non-collection meta and, for documents, produced a `//`
  // path segment (empty `{slug}`) that GitHub rejects as "malformed path
  // component" — the failure that made `update_status` unusable on documents.
  const changes: FileChange[] = []

  // A status change is a write, and gets the same stamp a content write does.
  // One timestamp for the whole call, so a bulk status change reads as the
  // single operation it was.
  const updatedAt = new Date().toISOString()

  if (modelDef.kind === 'document') {
    for (const rawSlug of entryIds) {
      const slug = rawSlug.toLowerCase()
      const slugError = validateSlug(slug)
      if (slugError) {
        return {
          branch: '',
          commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
          diff: [],
          validation: { valid: false, errors: [{ field: 'slug', message: slugError, severity: 'error' as const }] },
        }
      }

      const metaPath = resolveMetaPath(ctx.pathCtx, modelDef, locale, defaultLocale, slug)
      let existingMeta: Record<string, unknown> = {}
      try {
        existingMeta = JSON.parse(await reader.readFile(metaPath)) as Record<string, unknown>
      }
      catch { /* no meta yet */ }

      changes.push({
        path: metaPath,
        content: canonicalStringify({ ...existingMeta, status, updated_by: userEmail, updated_at: updatedAt }),
      })
    }
  }
  else if (modelDef.kind === 'collection') {
    const metaPath = resolveMetaPath(ctx.pathCtx, modelDef, locale, defaultLocale)
    let existingMeta: Record<string, EntryMeta> = {}
    try {
      existingMeta = JSON.parse(await reader.readFile(metaPath)) as Record<string, EntryMeta>
    }
    catch { /* no meta */ }

    for (const entryId of entryIds) {
      existingMeta[entryId] = {
        ...existingMeta[entryId],
        status,
        updated_by: userEmail,
        updated_at: updatedAt,
      } as EntryMeta
    }

    changes.push({ path: metaPath, content: canonicalStringify(existingMeta) })
  }
  else {
    // singleton / dictionary — a single top-level EntryMeta object.
    const metaPath = resolveMetaPath(ctx.pathCtx, modelDef, locale, defaultLocale)
    let existingMeta: Record<string, unknown> = {}
    try {
      existingMeta = JSON.parse(await reader.readFile(metaPath)) as Record<string, unknown>
    }
    catch { /* no meta */ }

    changes.push({
      path: metaPath,
      content: canonicalStringify({ ...existingMeta, status, updated_by: userEmail, updated_at: updatedAt }),
    })
  }

  // context.json is regenerated on `contentrain` post-merge (MCP 1.5.0
  // model), not committed on the feature branch.
  const allChanges: FileChange[] = changes.toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId, locale)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: ${status} ${entryIds.length} entries in ${modelId}\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
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
      commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
      diff: [],
      validation: { valid: false, errors: [{ field: '', message: 'Model does not support i18n', severity: 'error' as const }] },
    }
  }

  // i18n-guarded above, so `resolveMetaPath` uses the per-locale path regardless
  // of `defaultLocale`; we still thread it to satisfy the shared signature.
  const config = JSON.parse(await reader.readFile(resolveConfigPath(ctx.pathCtx))) as ContentrainConfig
  const defaultLocale = config.locales?.default ?? 'en'

  // Documents store content + meta per-slug, so a locale copy has to enumerate
  // every slug and copy each `{slug}/{locale}.md` + its per-slug meta. The
  // single-file logic below only fits the JSON kinds (collection / singleton /
  // dictionary); for a document it read the content *directory* as a file and
  // wrote a slug-less `//` meta path, so copy_locale silently did nothing.
  if (modelDef.kind === 'document') {
    return copyDocumentLocale(ctx, modelDef, modelId, fromLocale, toLocale, userEmail, reader, defaultLocale)
  }

  const sourcePath = resolveContentPath(ctx.pathCtx, modelDef, fromLocale)
  let sourceContent: string
  try {
    sourceContent = await reader.readFile(sourcePath)
  }
  catch {
    return {
      branch: '',
      commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
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
        commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
        diff: [],
        validation: { valid: false, errors: [{ field: '', message: `Target locale "${toLocale}" already has content. Delete it first to overwrite.`, severity: 'error' as const }] },
      }
    }
  }
  catch { /* target doesn't exist — good */ }

  const sourceMetaPath = resolveMetaPath(ctx.pathCtx, modelDef, fromLocale, defaultLocale)
  let metaContent = '{}\n'
  try {
    metaContent = await reader.readFile(sourceMetaPath)
  }
  catch { /* no meta */ }
  const targetMetaPath = resolveMetaPath(ctx.pathCtx, modelDef, toLocale, defaultLocale)

  const copyChanges: FileChange[] = [
    { path: targetPath, content: sourceContent },
    { path: targetMetaPath, content: metaContent },
  ]

  // context.json is regenerated on `contentrain` post-merge (MCP 1.5.0
  // model), not committed on the feature branch.
  const allChanges: FileChange[] = [...copyChanges]
    .toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: copy ${modelId} from ${fromLocale} to ${toLocale}\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}

/** Shared "nothing was written" result for the copy-locale guards. */
function copyLocaleError(message: string): WriteResult {
  return {
    branch: '',
    commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
    diff: [],
    validation: { valid: false, errors: [{ field: '', message, severity: 'error' as const }] },
  }
}

/**
 * Copy every document entry from one locale to another. Documents keep content
 * and meta per-slug (`{slug}/{locale}.md` + `.../meta/{modelId}/{slug}/{locale}.json`),
 * so — unlike the JSON kinds — the copy enumerates slugs and copies each pair.
 * Slugs that already have target-locale content are skipped (never overwrites),
 * matching the single-file copy semantics.
 */
async function copyDocumentLocale(
  ctx: EngineInternalContext,
  modelDef: ModelDefinition,
  modelId: string,
  fromLocale: string,
  toLocale: string,
  userEmail: string,
  reader: RepoReader,
  defaultLocale: string,
): Promise<WriteResult> {
  // No slug → `resolveContentPath` returns the model's content directory.
  const contentDir = resolveContentPath(ctx.pathCtx, modelDef, fromLocale)

  let slugs: string[]
  try {
    slugs = await reader.listDirectory(contentDir)
  }
  catch {
    return copyLocaleError(`Source locale "${fromLocale}" not found`)
  }

  const changes: FileChange[] = []
  for (const slug of slugs) {
    const sourcePath = resolveContentPath(ctx.pathCtx, modelDef, fromLocale, slug)
    let sourceContent: string
    try {
      sourceContent = await reader.readFile(sourcePath)
    }
    catch {
      continue // this slug has no source-locale content — nothing to copy
    }

    const targetPath = resolveContentPath(ctx.pathCtx, modelDef, toLocale, slug)
    try {
      const existing = await reader.readFile(targetPath)
      if (existing && existing.trim().length > 0) continue // never overwrite
    }
    catch { /* target doesn't exist — good */ }

    let metaContent = canonicalStringify({})
    try {
      metaContent = await reader.readFile(resolveMetaPath(ctx.pathCtx, modelDef, fromLocale, defaultLocale, slug))
    }
    catch { /* no source meta */ }

    changes.push(
      { path: targetPath, content: sourceContent },
      { path: resolveMetaPath(ctx.pathCtx, modelDef, toLocale, defaultLocale, slug), content: metaContent },
    )
  }

  if (changes.length === 0) {
    return copyLocaleError(`No documents to copy — "${toLocale}" already has content for every "${fromLocale}" entry.`)
  }

  // context.json is regenerated on `contentrain` post-merge (MCP 1.5.0
  // model), not committed on the feature branch.
  const allChanges: FileChange[] = changes.toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: copy ${modelId} from ${fromLocale} to ${toLocale}\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}
