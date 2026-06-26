import type { ContentrainConfig, FileChange, Vocabulary } from '@contentrain/types'
import { canonicalStringify, CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH, LOCALE_PATTERN } from '@contentrain/types'
import type { EngineInternalContext, WriteResult } from './types'
import { STUDIO_AUTHOR, CONTENT_BRANCH } from './types'
import { pinReaderToContentrain, createFeatureBranch } from './helpers'

function errResult(message: string): WriteResult {
  return {
    branch: '',
    commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
    diff: [],
    validation: { valid: false, errors: [{ field: '', message, severity: 'error' as const }] },
  }
}

/**
 * Register a new supported locale in `.contentrain/config.json`.
 *
 * Adds `locale` to `config.locales.supported` (the only place the locale
 * set lives — `validateLocale` rejects any locale not listed here, so this
 * is the prerequisite for translating content into a new language). Content
 * is NOT created; use copy_locale / save_content afterwards.
 */
export async function addLocale(
  ctx: EngineInternalContext,
  locale: string,
  userEmail: string,
): Promise<WriteResult> {
  await ctx.ensureContentBranch()

  if (!LOCALE_PATTERN.test(locale))
    return errResult(`Invalid locale code "${locale}". Use a BCP-47 code like "en" or "en-US".`)

  const reader = pinReaderToContentrain(ctx.git)

  let config: ContentrainConfig
  try {
    config = JSON.parse(await reader.readFile(resolveConfigPath(ctx.pathCtx))) as ContentrainConfig
  }
  catch {
    return errResult('Project config (config.json) not found — initialize the project first.')
  }

  if (config.locales.supported.includes(locale))
    return errResult(`Locale "${locale}" is already supported.`)

  const updated: ContentrainConfig = {
    ...config,
    locales: { ...config.locales, supported: [...config.locales.supported, locale] },
  }

  const change: FileChange = { path: resolveConfigPath(ctx.pathCtx), content: canonicalStringify(updated) }
  const { branchName } = await createFeatureBranch(ctx, 'config', 'locales')

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: [change],
    message: `contentrain: add locale ${locale}\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}

/**
 * Update `.contentrain/vocabulary.json` — the shared glossary used across
 * content + the generated SDK. The file is a `{ version, terms }` wrapper;
 * `terms` maps term → { locale: string }. Merges the given terms into the
 * existing set by default (set `replace` to overwrite the whole term map)
 * and bumps `version`.
 */
export async function saveVocabulary(
  ctx: EngineInternalContext,
  terms: Record<string, Record<string, string>>,
  userEmail: string,
  options?: { replace?: boolean },
): Promise<WriteResult> {
  await ctx.ensureContentBranch()

  if (!terms || typeof terms !== 'object' || Array.isArray(terms))
    return errResult('Vocabulary terms must be an object mapping term → { locale: value }.')

  const reader = pinReaderToContentrain(ctx.git)

  let existing: Vocabulary = { version: 0, terms: {} }
  try {
    const parsed = JSON.parse(await reader.readFile(resolveVocabularyPath(ctx.pathCtx))) as Partial<Vocabulary>
    if (parsed && typeof parsed === 'object')
      existing = { version: typeof parsed.version === 'number' ? parsed.version : 0, terms: parsed.terms ?? {} }
  }
  catch { /* no vocabulary yet */ }

  const mergedTerms = options?.replace ? terms : { ...existing.terms, ...terms }
  const merged: Vocabulary = { version: existing.version + 1, terms: mergedTerms }

  const change: FileChange = { path: resolveVocabularyPath(ctx.pathCtx), content: canonicalStringify(merged) }
  const { branchName } = await createFeatureBranch(ctx, 'config', 'vocabulary')

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: [change],
    message: `contentrain: update vocabulary\n\nCo-Authored-By: ${userEmail}`,
    author: STUDIO_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)
  return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
}
