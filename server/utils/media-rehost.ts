import type { ContentrainConfig, FileChange, ModelDefinition, RepoReader } from '@contentrain/types'
import { CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { CDNProvider } from '../providers/cdn'
import type { GitProvider } from '../providers/git'
import type { EngineMergeResult } from './content-engine/types'
import { STUDIO_AUTHOR } from './content-engine/types'
import { createFeatureBranch, openWriteSnapshot } from './content-engine/helpers'
import { resolveConfigPath, resolveContentPath, resolveModelContentDir, resolveModelsDir } from './content-paths'
import { mediaBaseFor, mediaStoragePathUnder } from './media-url'

/**
 * Media rehost (#321) — move a project's media references to this instance.
 *
 * Content commits media as absolute delivery URLs
 * (`{siteUrl}/api/cdn/v1/{projectId}/media/...`, see `media-rewrite.ts`), so
 * moving a project to another Studio instance, or reconnecting its repo as a
 * new project, leaves every reference pointing at the old host / project id.
 * This rewrites them to `publicMediaBase(projectId)` in ONE commit, and
 * refuses to commit while any referenced asset is missing from this project's
 * storage — a rewrite onto a 404 would break the live site instead of fixing it.
 *
 * The rewrite is textual over each content file, not a walk of the model's
 * media fields: references also live inside markdown bodies, richtext/markdown
 * fields and HTML, which `normalizeModelContentMedia` never visits. Only
 * the old base immediately followed by `/media/` matches (`mediaStoragePathUnder`
 * semantics), and unchanged bytes stay byte-identical, so the commit's diff is
 * exactly the URLs.
 *
 * `copyAssets` covers a project-id change inside one instance (same bucket):
 * every object under the old project's `media/` prefix that the new prefix
 * lacks is copied first. It copies storage objects only — media library rows
 * stay with the old project.
 */

export interface RehostSource {
  siteUrl: string
  projectId: string
}

export interface RehostInput {
  git: GitProvider
  cdn: CDNProvider
  contentRoot: string
  projectId: string
  /** This instance's public site URL (`runtimeConfig.public.siteUrl`). */
  siteUrl: string
  from: RehostSource
  dryRun: boolean
  copyAssets: boolean
  userEmail: string
  /** Land the rehost branch (`engine.mergeBranch`). */
  merge: (branch: string) => Promise<EngineMergeResult>
}

export interface RehostCounts {
  from: string
  to: string
  filesScanned: number
  filesChanged: number
  references: number
  mediaPaths: number
  /** Referenced paths this project's storage does not hold (after any copy). */
  missing: string[]
  copy: { requested: boolean, toCopy: number, copied: number }
}

export type RehostResult
  = | { status: 'dry_run', counts: RehostCounts }
    | { status: 'nothing_to_do', counts: RehostCounts }
    | { status: 'missing_assets', counts: RehostCounts }
    | { status: 'conflict', counts: RehostCounts }
    | { status: 'committed', counts: RehostCounts, branch: string, commitSha: string, merged: boolean, pullRequestUrl: string | null }

export type RehostSourceError = 'invalid_source' | 'same_source' | 'copy_other_instance'

const READ_CONCURRENCY = 8
const COPY_CONCURRENCY = 8

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeSiteUrl(siteUrl: string): string {
  return siteUrl.trim().replace(/\/+$/, '')
}

/** Validate the source before anything is read. Null when usable. */
export function checkRehostSource(input: { from: RehostSource, projectId: string, siteUrl: string, copyAssets: boolean }): RehostSourceError | null {
  const fromSite = normalizeSiteUrl(input.from.siteUrl)
  let url: URL
  try {
    url = new URL(fromSite)
  }
  catch {
    return 'invalid_source'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'invalid_source'
  if (!/^[\w-]{1,64}$/.test(input.from.projectId)) return 'invalid_source'

  const sameInstance = fromSite === normalizeSiteUrl(input.siteUrl)
  if (sameInstance && input.from.projectId === input.projectId) return 'same_source'
  if (input.copyAssets && !sameInstance) return 'copy_other_instance'
  return null
}

/**
 * Rewrite every `{fromBase}/media/...` reference in `text` to `{toBase}/media/...`.
 * Query/hash suffixes and everything around the URL are left as they were.
 * `paths` collects the distinct storage paths referenced.
 */
export function rehostText(text: string, fromBase: string, toBase: string): { text: string, references: number, paths: Set<string> } {
  const pattern = new RegExp(`${escapeRegExp(fromBase)}/(media/[^\\s"'<>()\\\\]+)`, 'g')
  const paths = new Set<string>()
  let references = 0
  const out = text.replace(pattern, (match, rest: string) => {
    const path = mediaStoragePathUnder(fromBase, match)
    if (!path) return match
    references++
    paths.add(path)
    return `${toBase}/${rest}`
  })
  return { text: out, references, paths }
}

/** The rewrite plan over a set of files — pure, used for both dry run and commit. */
export function planMediaRehost(
  files: Array<{ path: string, content: string }>,
  fromBase: string,
  toBase: string,
): { changes: FileChange[], references: number, paths: string[] } {
  const changes: FileChange[] = []
  const paths = new Set<string>()
  let references = 0
  for (const file of files) {
    const result = rehostText(file.content, fromBase, toBase)
    if (result.references === 0) continue
    references += result.references
    for (const p of result.paths) paths.add(p)
    changes.push({ path: file.path, content: result.text })
  }
  changes.sort((a, b) => a.path.localeCompare(b.path))
  return { changes, references, paths: [...paths].sort() }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length })
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Every content file of every model at the snapshot: JSON kinds by their
 * resolved per-locale path, documents by walking their directory for `.md`
 * (any locale strategy). Missing files are skipped.
 */
async function readContentFiles(
  git: GitProvider,
  reader: RepoReader,
  ref: string,
  contentRoot: string,
): Promise<Array<{ path: string, content: string }>> {
  const ctx = { contentRoot }
  const config = JSON.parse(await reader.readFile(resolveConfigPath(ctx))) as ContentrainConfig
  const locales = config.locales?.supported?.length ? config.locales.supported : [config.locales?.default ?? 'en']

  const modelsDir = resolveModelsDir(ctx)
  const models: ModelDefinition[] = []
  for (const file of await git.listDirectory(modelsDir, ref)) {
    if (!file.endsWith('.json')) continue
    try {
      models.push(JSON.parse(await reader.readFile(`${modelsDir}/${file}`)) as ModelDefinition)
    }
    catch { /* an unreadable model definition has no content to rehost */ }
  }

  const paths = new Set<string>()
  let tree: Array<{ path: string, type: string }> | null = null
  for (const model of models) {
    if (model.kind === 'document') {
      const dir = resolveModelContentDir(ctx, model).replace(/\/+$/, '')
      if (!dir) continue
      tree ??= await git.getTree(ref)
      for (const entry of tree) {
        if (entry.type === 'blob' && entry.path.startsWith(`${dir}/`) && entry.path.endsWith('.md'))
          paths.add(entry.path)
      }
      continue
    }
    for (const locale of model.i18n ? locales : ['data'])
      paths.add(resolveContentPath(ctx, model, locale))
  }

  const files = await mapLimit([...paths].sort(), READ_CONCURRENCY, async (path) => {
    try {
      return { path, content: await reader.readFile(path) }
    }
    catch {
      return null
    }
  })
  return files.filter((f): f is { path: string, content: string } => f !== null)
}

async function copyObject(cdn: CDNProvider, fromProjectId: string, toProjectId: string, path: string): Promise<void> {
  if (cdn.copyObject) {
    await cdn.copyObject(fromProjectId, path, toProjectId, path)
    return
  }
  const object = await cdn.getObject(fromProjectId, path)
  if (!object || 'notModified' in object) return
  await cdn.putObject(toProjectId, path, object.data, object.contentType)
}

async function storedMediaPaths(cdn: CDNProvider, projectId: string): Promise<Set<string>> {
  return new Set((await cdn.listObjects(projectId, 'media/')).map(o => o.path))
}

/** Plan (and unless `dryRun`, apply) the rehost. The source must pass `checkRehostSource` first. */
export async function runMediaRehost(input: RehostInput): Promise<RehostResult> {
  const { git, cdn, projectId } = input
  const fromBase = mediaBaseFor(normalizeSiteUrl(input.from.siteUrl), input.from.projectId)
  const toBase = mediaBaseFor(normalizeSiteUrl(input.siteUrl), projectId)

  const snapshot = await openWriteSnapshot(git)
  const ref = snapshot.baseSha ?? CONTENTRAIN_BRANCH
  const files = await readContentFiles(git, snapshot.reader, ref, input.contentRoot)
  const plan = planMediaRehost(files, fromBase, toBase)

  let stored = await storedMediaPaths(cdn, projectId)
  let toCopy: string[] = []
  let copied = 0
  if (input.copyAssets) {
    toCopy = [...await storedMediaPaths(cdn, input.from.projectId)].filter(p => !stored.has(p)).sort()
    if (input.dryRun) {
      stored = new Set([...stored, ...toCopy])
    }
    else if (toCopy.length > 0) {
      await mapLimit(toCopy, COPY_CONCURRENCY, async (path) => {
        await copyObject(cdn, input.from.projectId, projectId, path)
        copied++
      })
      // Verify against storage, not against what the copy loop believes.
      stored = await storedMediaPaths(cdn, projectId)
    }
  }

  const counts: RehostCounts = {
    from: fromBase,
    to: toBase,
    filesScanned: files.length,
    filesChanged: plan.changes.length,
    references: plan.references,
    mediaPaths: plan.paths.length,
    missing: plan.paths.filter(p => !stored.has(p)),
    copy: { requested: input.copyAssets, toCopy: toCopy.length, copied },
  }

  if (input.dryRun) return { status: 'dry_run', counts }
  if (counts.missing.length > 0) return { status: 'missing_assets', counts }
  if (plan.changes.length === 0) return { status: 'nothing_to_do', counts }

  const { branchName } = await createFeatureBranch(
    { git, pathCtx: { contentRoot: input.contentRoot }, projectId, ensureContentBranch: () => Promise.resolve() },
    'media',
    'rehost',
    undefined,
    snapshot.baseSha,
  )
  const commit = await git.applyPlan({
    branch: branchName,
    changes: plan.changes,
    message: [
      'contentrain: rehost media references',
      '',
      `${fromBase} -> ${toBase}`,
      `${plan.references} references to ${plan.paths.length} media paths in ${plan.changes.length} files`,
      '',
      `Co-Authored-By: ${input.userEmail}`,
    ].join('\n'),
    author: STUDIO_AUTHOR,
    base: CONTENTRAIN_BRANCH,
  })

  // The files were read at the snapshot; a save that landed since makes the
  // merge a conflict — never overwrite it, ask for a re-run instead.
  let merge: EngineMergeResult
  try {
    merge = await input.merge(branchName)
  }
  catch (error) {
    const status = error as { status?: number, statusCode?: number }
    if (status.status !== 409 && status.statusCode !== 409) throw error
    merge = { merged: false, sha: null, pullRequestUrl: null, conflict: true }
  }
  if (merge.conflict || (!merge.merged && !merge.pullRequestUrl)) {
    await git.deleteBranch(branchName).catch(() => {})
    return { status: 'conflict', counts }
  }

  return {
    status: 'committed',
    counts,
    branch: branchName,
    commitSha: commit.sha,
    merged: merge.merged,
    pullRequestUrl: merge.pullRequestUrl ?? null,
  }
}
