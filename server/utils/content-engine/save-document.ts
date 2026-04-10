import type { EntryMeta, ModelDefinition } from '@contentrain/types'
import { validateSlug } from '@contentrain/types'
import type { EngineInternalContext, WriteResult } from './types'
import { BOT_AUTHOR, CONTENT_BRANCH } from './types'
import { buildContextUpdate, createFeatureBranch } from './helpers'

/**
 * Save a document (markdown with frontmatter).
 * Creates or updates a markdown file at the document path.
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
  // Validate slug format (lowercase alphanumeric + hyphens, no path traversal)
  const safeSlug = slug.toLowerCase()
  const slugError = validateSlug(safeSlug)
  if (slugError) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
      diff: [],
      validation: { valid: false, errors: [{ field: 'slug', message: slugError, severity: 'error' as const }] },
    }
  }

  await ctx.ensureContentBranch()

  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await ctx.git.readFile(modelPath, CONTENT_BRANCH)) as ModelDefinition

  // Validate frontmatter against model fields
  const fields = modelDef.fields ?? {}
  const validation = validateContent(frontmatter, fields, modelId, locale, safeSlug)
  if (!validation.valid) {
    return {
      branch: '',
      commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
      diff: [],
      validation,
    }
  }

  // Resolve document path (uses sanitized slug)
  const docPath = resolveContentPath(ctx.pathCtx, modelDef, locale, safeSlug)
  const serialized = serializeMarkdownFrontmatter({ ...frontmatter, slug: safeSlug }, body)

  // Meta
  const metaPath = resolveMetaPath(ctx.pathCtx, modelDef, locale, safeSlug)
  let existingMeta: Record<string, unknown> = {}
  try {
    existingMeta = JSON.parse(await ctx.git.readFile(metaPath, CONTENT_BRANCH)) as Record<string, unknown>
  }
  catch { /* no existing meta */ }
  const docDefaultStatus = options?.autoPublish ? 'published' : 'draft'
  const existingDocStatus = (existingMeta as unknown as EntryMeta).status
  const updatedMeta = {
    ...existingMeta,
    status: options?.autoPublish ? 'published' : (existingDocStatus ?? docDefaultStatus),
    source: 'agent' as const,
    updated_by: userEmail,
  }

  // Context.json
  const contextPath = resolveContextPath(ctx.pathCtx)
  const projectInfo = await ctx.getProjectInfo(locale)
  const contextJson = await buildContextUpdate(ctx, contextPath, { tool: 'save_content', model: modelId, locale, entries: [slug] }, projectInfo.modelCount, projectInfo.locales, CONTENT_BRANCH)

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId, locale)

  const message = `contentrain: save document ${modelId}/${safeSlug} [${locale}]\n\nCo-Authored-By: ${userEmail}`
  const commit = await ctx.git.commitFiles(
    branchName,
    [
      { path: docPath, content: serialized },
      { path: metaPath, content: serializeCanonical(updatedMeta) },
      { path: contextPath, content: contextJson },
    ],
    message,
    BOT_AUTHOR,
  )

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation }
}
