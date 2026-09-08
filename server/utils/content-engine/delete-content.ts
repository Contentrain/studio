import type { ContentrainConfig, FileChange, ModelDefinition, RepoReader } from '@contentrain/types'
import { CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH, validateSlug } from '@contentrain/types'
import type { ContentDeleteInput } from '@contentrain/mcp/core/ops'
import { planContentDelete } from '@contentrain/mcp/core/ops'
import { OverlayReader } from '@contentrain/mcp/core/overlay-reader'
import type { EngineInternalContext, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
import { pinReaderToContentrain, createFeatureBranch } from './helpers'

function invalid(field: string, message: string): WriteResult {
  return {
    branch: '',
    commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
    diff: [],
    validation: { valid: false, errors: [{ field, message, severity: 'error' as const }] },
  }
}

/**
 * Delete content entries from a model.
 *
 * `entryIds` is addressed per kind, the way the `delete_content` tool
 * documents it: entry ids for a collection, slugs for a document, keys for a
 * dictionary. `planContentDelete` expects each of those under a different
 * input field (`id` / `slug` / `keys`) — handing every kind an `id` made a
 * document delete throw "Document delete requires a slug" whatever the caller
 * passed, and would have made a dictionary delete drop the whole locale file
 * instead of the listed keys (MCP deletes the file when `keys` is absent).
 *
 * Collections and documents plan one entry per call, so we fan out and chain
 * `OverlayReader`s: every subsequent plan sees the post-delete state of the
 * prior plan, which keeps the running content-map + meta-map correct even
 * when multiple deletions collapse into one file. A dictionary plans all keys
 * at once, so a missing key fails the whole batch before anything is written.
 */
export async function deleteContent(
  ctx: EngineInternalContext,
  modelId: string,
  locale: string,
  entryIds: string[],
  userEmail: string,
): Promise<WriteResult> {
  await ctx.ensureContentBranch()

  const reader = pinReaderToContentrain(ctx.git)

  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await reader.readFile(modelPath)) as ModelDefinition

  // MCP 2.x `planContentDelete` needs the default locale to resolve a non-i18n
  // model's single meta record (it lives under the default locale, not the
  // caller's). Read it from config — same source `planContentSave` uses.
  const config = JSON.parse(await reader.readFile(resolveConfigPath(ctx.pathCtx))) as ContentrainConfig
  const defaultLocale = config.locales?.default ?? 'en'

  let inputs: ContentDeleteInput[]
  switch (modelDef.kind) {
    case 'document': {
      // A document is deleted whole — every locale's `{slug}/{locale}.md` and
      // per-slug meta. Passing `locale` would only narrow the meta cleanup
      // (MCP removes the whole slug directory for the default `file` strategy
      // regardless), leaving the other locales' meta orphaned.
      inputs = []
      for (const rawSlug of entryIds) {
        const slug = rawSlug.toLowerCase()
        const slugError = validateSlug(slug)
        if (slugError) return invalid('slug', slugError)
        inputs.push({ model: modelDef, slug, defaultLocale })
      }
      break
    }
    case 'dictionary':
      inputs = [{ model: modelDef, keys: entryIds, locale, defaultLocale }]
      break
    default:
      inputs = entryIds.map(id => ({ model: modelDef, id, locale, defaultLocale }))
  }

  let workingReader: RepoReader = reader
  const changesByPath = new Map<string, FileChange>()

  for (const input of inputs) {
    const plan = await planContentDelete(workingReader, input)
    for (const change of plan.changes) {
      changesByPath.set(change.path, change)
    }
    workingReader = new OverlayReader(workingReader, plan.changes)
  }

  // Nothing matched (unknown id / slug): don't spend a branch + merge cycle on
  // an empty commit — tell the caller instead.
  if (changesByPath.size === 0) {
    return invalid('entryIds', `No content found to delete in "${modelId}" for: ${entryIds.join(', ')}`)
  }

  // context.json is regenerated on `contentrain` post-merge (MCP 1.5.0
  // model), not committed on the feature branch.
  const allChanges: FileChange[] = [...changesByPath.values()]
    .toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId, locale)

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: delete ${entryIds.length} entries from ${modelId} [${locale}]\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)

  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}
