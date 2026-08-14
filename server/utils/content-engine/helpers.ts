import { canonicalStringify, CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { EntryMeta, FileChange, ModelDefinition, RepoReader } from '@contentrain/types'
import type { ContentEntry } from '@contentrain/mcp/core/content-manager'
import type { EngineInternalContext, GitProvider } from './types'
import { checkBranchHealth, getHealthStatus } from '../branch-health'

/**
 * Generate a v2 branch name following git-architecture.md §2.3:
 * cr/{scope}/{target}[/{locale}]/{timestamp}-{suffix}
 */
export function generateBranchName(scope: string, target: string, locale?: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(2)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  const parts = ['cr', scope, target]
  if (locale) parts.push(locale)
  parts.push(`${timestamp}-${suffix}`)
  return parts.join('/')
}

/**
 * Pick a `cr/*` feature-branch name with the branch-health guard in
 * front. Blocks above the 80-branch threshold, warns above 50.
 *
 * Note: as of Faz S2 this helper no longer calls `createBranch` up
 * front — `provider.applyPlan({ branch, base })` creates the branch
 * atomically together with the first commit. The name is kept for
 * backward compatibility with existing Studio callers and tests.
 */
export async function createFeatureBranch(
  ctx: EngineInternalContext,
  scope: string,
  target: string,
  locale?: string,
): Promise<{ branchName: string, healthWarning?: string }> {
  if (ctx.projectId) {
    const cached = await getHealthStatus(ctx.projectId)
    const health = cached ?? await checkBranchHealth(ctx.git, ctx.projectId, ctx.pathCtx.contentRoot)

    if (health.status === 'blocked') {
      throw createError({
        statusCode: 429,
        message: errorMessage('branches.health_blocked'),
      })
    }

    return {
      branchName: generateBranchName(scope, target, locale),
      healthWarning: health.status === 'warning'
        ? `Warning: ${health.unmergedCount} unmerged branches. Review and merge pending branches.`
        : undefined,
    }
  }

  return { branchName: generateBranchName(scope, target, locale) }
}

/**
 * Normalize content data to object-map format.
 * Contentrain MCP stores collections as arrays: [{id: "abc", ...}, ...]
 * Studio uses object-maps: { "abc": { ... } }
 * This function converts arrays to object-maps for consistent handling.
 */
export function toObjectMap(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    const map: Record<string, unknown> = {}
    for (let i = 0; i < data.length; i++) {
      const entry = data[i]
      if (typeof entry === 'object' && entry !== null) {
        const id = (entry as Record<string, unknown>).id
          ?? (entry as Record<string, unknown>).ID
          ?? `entry-${i}`
        const { id: _id, ID: _ID, ...fields } = entry as Record<string, unknown>
        map[String(id)] = fields
      }
    }
    return map
  }
  if (typeof data === 'object' && data !== null) {
    return data as Record<string, unknown>
  }
  return {}
}

/**
 * Wrap a `RepoProvider`'s reader surface so every read defaults to the
 * `contentrain` tracking branch when no explicit ref is given.
 *
 * MCP's core/ops helpers (planContentSave, buildContextChange, …) call
 * `reader.readFile(path)` without a ref; without this wrapper, remote
 * providers would resolve against the repository's default branch
 * (`main` / `master` / …) — which is downstream of the content SSOT.
 */
export function pinReaderToContentrain(git: GitProvider): RepoReader {
  return {
    readFile: (path, ref) => git.readFile(path, ref ?? CONTENTRAIN_BRANCH),
    listDirectory: (path, ref) => git.listDirectory(path, ref ?? CONTENTRAIN_BRANCH),
    fileExists: (path, ref) => git.fileExists(path, ref ?? CONTENTRAIN_BRANCH),
  }
}

/**
 * Whether every planned file is byte-identical to what `contentrain`
 * already holds — i.e. the save is a no-op. Reliable because the plan
 * output is deterministic (`canonicalStringify` for JSON, and Studio's
 * meta override writes no timestamps), so identical input produces
 * identical bytes. Deletions (`content: null`) and brand-new files never
 * count as no-ops.
 *
 * The two extra reads per save are far cheaper than what a no-op used to
 * cost: a branch, an empty commit, a merge to `contentrain`, and a
 * `contentrain`→main advance (~18s wall-clock on staging).
 */
export async function planMatchesCurrent(reader: RepoReader, changes: FileChange[]): Promise<boolean> {
  if (changes.length === 0) return false
  for (const change of changes) {
    if (typeof change.content !== 'string') return false
    let current: string
    try {
      current = await reader.readFile(change.path)
    }
    catch {
      return false
    }
    if (current !== change.content) return false
  }
  return true
}

/**
 * Override the meta FileChange produced by `planContentSave` with
 * Studio's status semantics:
 *
 * - `source: 'agent'` (same as MCP)
 * - `updated_by: userEmail` (MCP would set `'contentrain-mcp'`)
 * - `status`: existing status preserved when already set, otherwise
 *   `'published'` when `autoPublish`, else `'draft'`
 *
 * MCP's `defaultMeta` always resets status to `'draft'`; Studio needs to
 * honour in-progress review states and the workspace's auto-publish
 * workflow. The existing meta is read from `contentrain` (via the pinned
 * reader) so the override is applied relative to post-commit state.
 */
export async function applyStudioMetaOverrides(args: {
  planChanges: FileChange[]
  metaPath: string
  model: ModelDefinition
  touchedIds: string[]
  reader: RepoReader
  autoPublish: boolean
  userEmail: string
}): Promise<FileChange[]> {
  const { planChanges, metaPath, model, touchedIds, reader, autoPublish, userEmail } = args

  let existingMeta: Record<string, unknown> = {}
  try {
    existingMeta = JSON.parse(await reader.readFile(metaPath)) as Record<string, unknown>
  }
  catch { /* no existing meta */ }

  // `updated_at` describes THIS write, like `source` and `updated_by` — so it
  // is stamped every time and shares one timestamp across the entries of a
  // single save. MCP mints it too, but this override replaces MCP's meta
  // wholesale; without stamping it here the field would never survive a Studio
  // write, and "sort by recently edited" would have no data for exactly the
  // entries Studio users create.
  const updatedAt = new Date().toISOString()

  let updatedMeta: unknown
  if (model.kind === 'collection') {
    const metaMap = { ...existingMeta } as Record<string, EntryMeta>
    for (const entryId of touchedIds) {
      const existingStatus = metaMap[entryId]?.status
      metaMap[entryId] = {
        ...(metaMap[entryId] ?? {}),
        status: autoPublish ? 'published' : (existingStatus ?? 'draft'),
        source: 'agent',
        updated_by: userEmail,
        updated_at: updatedAt,
      } as EntryMeta
    }
    updatedMeta = metaMap
  }
  else {
    const existingStatus = (existingMeta as unknown as EntryMeta).status
    updatedMeta = {
      ...existingMeta,
      status: autoPublish ? 'published' : (existingStatus ?? 'draft'),
      source: 'agent' as const,
      updated_by: userEmail,
      updated_at: updatedAt,
    }
  }

  const studioMetaChange: FileChange = {
    path: metaPath,
    content: canonicalStringify(updatedMeta),
  }

  return planChanges.map(c => c.path === metaPath ? studioMetaChange : c)
}

/**
 * Convert Studio's `data: Record<string, unknown>` input shape into
 * the `ContentEntry[]` shape that MCP's `planContentSave` consumes.
 *
 * - Collection: each entry becomes its own `ContentEntry`
 *   (keyed by id). Array input is normalised first via `toObjectMap`.
 * - Singleton / dictionary: the data goes through as a single entry.
 */
export function shapeEntriesForSave(
  model: ModelDefinition,
  data: Record<string, unknown>,
  locale: string,
): ContentEntry[] {
  if (model.kind === 'collection') {
    const map = toObjectMap(data)
    return Object.entries(map).map(([id, fields]) => ({
      id,
      locale,
      data: fields as Record<string, unknown>,
    }))
  }

  return [{ locale, data }]
}
