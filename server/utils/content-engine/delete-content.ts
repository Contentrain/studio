import type { ContentrainConfig, FileChange, ModelDefinition, RepoReader } from '@contentrain/types'
import { validateSlug } from '@contentrain/types'
import type { ContentDeleteInput } from '@contentrain/mcp/core/ops'
import { planContentDelete } from '@contentrain/mcp/core/ops'
import { OverlayReader } from '@contentrain/mcp/core/overlay-reader'
import type { EngineInternalContext, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
import { openWriteSnapshot, createFeatureBranch, toObjectMap, writeBase } from './helpers'

function invalid(field: string, message: string): WriteResult {
  return {
    branch: '',
    commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
    diff: [],
    validation: { valid: false, errors: [{ field, message, severity: 'error' as const }] },
  }
}

/** Read-only: which of `locales` still hold at least one of `entryIds`, so a narrowed delete's warning never claims a locale that never had the entry (#284). */
async function localesStillHolding(reader: RepoReader, ctx: EngineInternalContext, modelDef: ModelDefinition, locales: string[], entryIds: string[]): Promise<string[]> {
  const holding: string[] = []
  for (const loc of locales) {
    try {
      const raw = JSON.parse(await reader.readFile(resolveContentPath(ctx.pathCtx, modelDef, loc)))
      const data = toObjectMap(raw) as Record<string, unknown>
      if (entryIds.some(id => id in data)) holding.push(loc)
    }
    catch { /* no content file for this locale */ }
  }
  return holding
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
 *
 * #284 — an i18n entry is one translation unit, not one file per locale, so a
 * delete removes it from every configured locale by default. `locales`
 * narrows to a subset; every locale left out is reported back in
 * `remainingLocales` (only the ones actually still holding the entry — never
 * claims a locale the entry was never in) so the caller can't mistake a
 * narrowed delete for a full one. Collections and dictionaries loop the
 * target locales themselves, since MCP's own `ContentDeleteInput.locale` is
 * singular. Documents keep MCP's whole-slug-directory delete (every locale,
 * unconditionally, same as before this policy) — narrowing a document delete
 * to specific locales isn't supported yet and is refused explicitly rather
 * than silently ignored; `locale` alone (unchanged, #301) still selects which
 * locale a non-i18n model's single copy is addressed at.
 */
export async function deleteContent(
  ctx: EngineInternalContext,
  modelId: string,
  locale: string,
  entryIds: string[],
  userEmail: string,
  locales?: string[],
): Promise<WriteResult & { touchedLocales?: string[], remainingLocales?: string[] }> {
  await ctx.ensureContentBranch()

  const snapshot = await openWriteSnapshot(ctx.git)
  const reader = snapshot.reader

  const modelPath = resolveModelPath(ctx.pathCtx, modelId)
  const modelDef = JSON.parse(await reader.readFile(modelPath)) as ModelDefinition

  // MCP 2.x `planContentDelete` needs the default locale to resolve a non-i18n
  // model's single meta record (it lives under the default locale, not the
  // caller's). Read it from config — same source `planContentSave` uses.
  const config = JSON.parse(await reader.readFile(resolveConfigPath(ctx.pathCtx))) as ContentrainConfig
  const defaultLocale = config.locales?.default ?? 'en'
  const allLocales = config.locales?.supported ?? [locale]

  // The locales this call writes to. Non-i18n content and documents keep the
  // single `locale` they always used — the multi-locale default only applies
  // where an entry genuinely has more than one locale's copy to delete.
  let targetLocales = [locale]
  if (modelDef.i18n && modelDef.kind !== 'document') {
    if (locales && locales.length > 0) {
      const unknown = locales.filter(l => !allLocales.includes(l))
      if (unknown.length > 0) return invalid('locales', `Not a configured locale for this project: ${unknown.join(', ')}`)
      targetLocales = [...new Set(locales)]
    }
    else {
      targetLocales = allLocales
    }
  }
  else if (modelDef.i18n && modelDef.kind === 'document' && locales && locales.length > 0) {
    const narrowed = locales.length < allLocales.length || locales.some(l => !allLocales.includes(l))
    if (narrowed) {
      return invalid('locales', 'Deleting only some locales of a document is not supported yet — every locale is removed together. Omit "locales" to delete the whole document.')
    }
  }

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
    // Non-i18n content is locale-agnostic (stored in one file) — MCP refuses
    // a `locale` on it outright, so it's only ever set for an i18n model.
    case 'dictionary':
      inputs = targetLocales.map(loc => ({ model: modelDef, keys: entryIds, ...(modelDef.i18n ? { locale: loc } : {}), defaultLocale }))
      break
    default:
      inputs = targetLocales.flatMap(loc => entryIds.map(id => ({ model: modelDef, id, ...(modelDef.i18n ? { locale: loc } : {}), defaultLocale })))
  }

  let workingReader: RepoReader = reader
  const changesByPath = new Map<string, FileChange>()
  const touchedLocales = new Set<string>()

  for (const input of inputs) {
    const plan = await planContentDelete(workingReader, input)
    if (plan.changes.length > 0 && input.locale) touchedLocales.add(input.locale)
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

  // A document delete removes every locale unconditionally (see above) — not
  // reflected in `touchedLocales` via `input.locale`, since document inputs
  // never carry one. Same for non-i18n content: its inputs carry no `locale`
  // either (single file, see above), so it's the addressed `locale` itself.
  if (modelDef.kind === 'document') {
    for (const loc of allLocales) touchedLocales.add(loc)
  }
  else if (!modelDef.i18n) {
    touchedLocales.add(locale)
  }

  const excludedLocales = modelDef.i18n && modelDef.kind !== 'document'
    ? allLocales.filter(loc => !targetLocales.includes(loc))
    : []
  const remainingLocales = excludedLocales.length > 0
    ? await localesStillHolding(reader, ctx, modelDef, excludedLocales, entryIds)
    : []

  // context.json is regenerated on `contentrain` post-merge (MCP 1.5.0
  // model), not committed on the feature branch.
  const allChanges: FileChange[] = [...changesByPath.values()]
    .toSorted((a, b) => a.path.localeCompare(b.path))

  const { branchName } = await createFeatureBranch(ctx, 'content', modelId, locale)

  const touchedList = [...touchedLocales].toSorted()
  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: allChanges,
    message: `contentrain: delete ${entryIds.length} entries from ${modelId} [${touchedList.join(',') || locale}]\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: writeBase(snapshot),
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)

  return {
    branch: branchName,
    commit,
    diff,
    validation: { valid: true, errors: [] },
    touchedLocales: touchedList,
    ...(remainingLocales.length > 0 ? { remainingLocales } : {}),
  }
}
