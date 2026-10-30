import type { ContentrainConfig, FileChange, ModelDefinition, RepoReader } from '@contentrain/types'
import { planContentDelete, planContentSave } from '@contentrain/mcp/core/ops'
import { OverlayReader } from '@contentrain/mcp/core/overlay-reader'
import type { EngineInternalContext, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
import { applyStudioMetaOverrides, asMcpConfig, createFeatureBranch, openWriteSnapshot, writeBase } from './helpers'

function invalid(field: string, message: string): WriteResult {
  return {
    branch: '',
    commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
    diff: [],
    validation: { valid: false, errors: [{ field, message, severity: 'error' as const }] },
  }
}

async function readDictionary(reader: RepoReader, path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await reader.readFile(path)) as Record<string, unknown>
  }
  catch {
    return null
  }
}

/**
 * Rename a dictionary key in one commit: in every locale that holds `from`,
 * `to` takes its value and `from` goes. Neither MCP op renames, so it is a
 * delete of `from` then a save of `to` per locale, chained through
 * `OverlayReader`s so each plan sees the one before it.
 *
 * Refused when `to` already exists in any locale — a rename that silently
 * overwrote a value there would lose it — and when no locale holds `from`.
 */
export async function renameDictionaryKey(
  ctx: EngineInternalContext,
  modelId: string,
  from: string,
  to: string,
  userEmail: string,
): Promise<WriteResult & { touchedLocales?: string[] }> {
  if (!to || to === from) return invalid('to', `The new key must differ from "${from}"`)

  await ctx.ensureContentBranch()

  const snapshot = await openWriteSnapshot(ctx.git)
  const reader = snapshot.reader

  const modelDef = JSON.parse(await reader.readFile(resolveModelPath(ctx.pathCtx, modelId))) as ModelDefinition
  if (modelDef.kind !== 'dictionary') return invalid('modelId', `"${modelId}" is not a dictionary`)

  const config = JSON.parse(await reader.readFile(resolveConfigPath(ctx.pathCtx))) as ContentrainConfig
  const defaultLocale = config.locales?.default ?? 'en'
  const locales = modelDef.i18n ? (config.locales?.supported ?? [defaultLocale]) : [defaultLocale]

  const holding: Array<{ locale: string, value: unknown }> = []
  const clashes: string[] = []
  for (const loc of locales) {
    const data = await readDictionary(reader, resolveContentPath(ctx.pathCtx, modelDef, loc))
    if (!data) continue
    if (to in data) clashes.push(loc)
    if (from in data) holding.push({ locale: loc, value: data[from] })
  }
  if (clashes.length > 0) return invalid('to', `Key "${to}" already exists in ${modelId} (${clashes.join(', ')})`)
  if (holding.length === 0) return invalid('from', `Key "${from}" not found in ${modelId}`)

  let workingReader: RepoReader = reader
  const changesByPath = new Map<string, FileChange>()
  const apply = (changes: FileChange[]) => {
    for (const change of changes) changesByPath.set(change.path, change)
    workingReader = new OverlayReader(workingReader, changes)
  }

  for (const { locale, value } of holding) {
    const localeInput = modelDef.i18n ? { locale } : {}
    apply((await planContentDelete(workingReader, { model: modelDef, keys: [from], ...localeInput, defaultLocale })).changes)
    const saved = await planContentSave(workingReader, {
      model: modelDef,
      entries: [{ locale, data: { [to]: value } }],
      config: asMcpConfig(config),
    })
    const patched = await applyStudioMetaOverrides({
      planChanges: saved.changes,
      metaPath: resolveMetaPath(ctx.pathCtx, modelDef, locale, defaultLocale),
      model: modelDef,
      touchedIds: [],
      reader: workingReader,
      autoPublish: false,
      userEmail,
      source: 'human',
    })
    apply(patched)
  }

  const touchedLocales = holding.map(h => h.locale).toSorted()
  const { branchName } = await createFeatureBranch(ctx, 'content', modelId, touchedLocales[0])
  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: [...changesByPath.values()].toSorted((a, b) => a.path.localeCompare(b.path)),
    message: `contentrain: rename ${modelId} key ${from} → ${to} [${touchedLocales.join(',')}]\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: writeBase(snapshot),
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] }, touchedLocales }
}
