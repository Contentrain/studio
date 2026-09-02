import { canonicalStringify, CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { EntryMeta, FileChange, ModelDefinition, RepoReader } from '@contentrain/types'
import type { ContentEntry } from '@contentrain/mcp/core/content-manager'
import type { EngineInternalContext, GitProvider, EntrySchedule } from './types'
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
 * Re-own the meta FileChange produced by `planContentSave` for Studio:
 *
 * - `updated_by: userEmail` (MCP writes `'contentrain-mcp'`)
 * - `status`: the record's current status kept, otherwise `'published'`
 *   when `autoPublish`, else `'draft'`
 * - `updated_at`, `source: 'agent'`: stamped for this write
 *
 * The base is the meta MCP just planned, not the file on `contentrain`.
 * MCP's `mergeEntryMeta` starts from the prior record and then applies
 * what this write carries — since 3.1.8 that includes `publish_at` /
 * `expire_at`, meta-only. Rebuilding from the prior file, as this used to,
 * threw away every key the plan had just set: a schedule sent with the
 * save never reached the commit. The prior file is read only when the plan
 * holds no change for `metaPath` (a caller that assembled its own plan).
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

  let baseMeta: Record<string, unknown> = {}
  const planned = planChanges.find(c => c.path === metaPath)
  if (typeof planned?.content === 'string') {
    try {
      baseMeta = JSON.parse(planned.content) as Record<string, unknown>
    }
    catch { /* not JSON — treat as absent */ }
  }
  else {
    try {
      baseMeta = JSON.parse(await reader.readFile(metaPath)) as Record<string, unknown>
    }
    catch { /* no existing meta */ }
  }

  // `updated_at` describes THIS write, like `source` and `updated_by` — so it
  // is stamped every time and shares one timestamp across the entries of a
  // single save. "Sort by recently edited" reads it for exactly the entries
  // Studio users create.
  const updatedAt = new Date().toISOString()

  // MCP already resolved `status` to "the prior record's, else draft", which
  // is Studio's rule too; autoPublish is the one thing Studio adds on top.
  let updatedMeta: unknown
  if (model.kind === 'collection') {
    const metaMap = { ...baseMeta } as Record<string, EntryMeta>
    for (const entryId of touchedIds) {
      const currentStatus = metaMap[entryId]?.status
      metaMap[entryId] = {
        ...(metaMap[entryId] ?? {}),
        status: autoPublish ? 'published' : (currentStatus ?? 'draft'),
        source: 'agent',
        updated_by: userEmail,
        updated_at: updatedAt,
      } as EntryMeta
    }
    updatedMeta = metaMap
  }
  else {
    const currentStatus = (baseMeta as unknown as EntryMeta).status
    updatedMeta = {
      ...baseMeta,
      status: autoPublish ? 'published' : (currentStatus ?? 'draft'),
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

const SCHEDULE_KEYS = ['publish_at', 'expire_at'] as const

/**
 * Why a schedule cannot be written, or null. `null` values are clears and
 * always valid; a string must parse as a date, and an expiry must follow the
 * publish date it is paired with.
 */
export function validateSchedule(schedule: EntrySchedule | undefined): string | null {
  if (!schedule) return null
  for (const key of SCHEDULE_KEYS) {
    const value = schedule[key]
    if (typeof value === 'string' && Number.isNaN(new Date(value).getTime()))
      return `Invalid ${key} date: "${value}". Must be a valid ISO 8601 date string.`
  }
  if (typeof schedule.publish_at === 'string' && typeof schedule.expire_at === 'string'
    && new Date(schedule.expire_at) <= new Date(schedule.publish_at))
    return `expire_at (${schedule.expire_at}) must be after publish_at (${schedule.publish_at}).`
  return null
}

/**
 * Split an entry's scheduling off its data.
 *
 * Scheduling rides on the entry (meta), never inside `data` (the content
 * file). An agent that still writes `publish_at` into the data — the habit
 * MCP 3.1.7 taught it — gets the value moved rather than leaked into the
 * content file, unless the model genuinely declares a field by that name.
 * The save-level schedule fills what the entry did not say.
 */
export function splitEntrySchedule(
  model: ModelDefinition,
  data: Record<string, unknown>,
  saveSchedule: EntrySchedule | undefined,
): { data: Record<string, unknown>, schedule: EntrySchedule } {
  const schedule: EntrySchedule = {}
  for (const key of SCHEDULE_KEYS) {
    if (saveSchedule && saveSchedule[key] !== undefined) schedule[key] = saveSchedule[key]
  }
  const declared = model.fields ?? {}
  const lifted = new Set<string>()
  for (const key of SCHEDULE_KEYS) {
    if (!(key in data) || key in declared) continue
    const value = data[key]
    if (typeof value === 'string' || value === null) schedule[key] = value
    lifted.add(key)
  }
  if (lifted.size === 0) return { data, schedule }
  return { data: Object.fromEntries(Object.entries(data).filter(([key]) => !lifted.has(key))), schedule }
}

/**
 * Convert Studio's `data: Record<string, unknown>` input shape into
 * the `ContentEntry[]` shape that MCP's `planContentSave` consumes.
 *
 * - Collection: each entry becomes its own `ContentEntry`
 *   (keyed by id). Array input is normalised first via `toObjectMap`.
 * - Singleton / dictionary: the data goes through as a single entry.
 *
 * Scheduling keys land on the entry, not in its data — see
 * {@link splitEntrySchedule}. A dictionary has no per-entry meta to
 * schedule and is passed through untouched.
 */
export function shapeEntriesForSave(
  model: ModelDefinition,
  data: Record<string, unknown>,
  locale: string,
  schedule?: EntrySchedule,
): ContentEntry[] {
  if (model.kind === 'dictionary') return [{ locale, data }]

  if (model.kind === 'collection') {
    const map = toObjectMap(data)
    return Object.entries(map).map(([id, fields]) => {
      const split = splitEntrySchedule(model, fields as Record<string, unknown>, schedule)
      return { id, locale, data: split.data, ...split.schedule }
    })
  }

  const split = splitEntrySchedule(model, data, schedule)
  return [{ locale, data: split.data, ...split.schedule }]
}
