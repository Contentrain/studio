/**
 * Migration handoff intake (S-09).
 *
 * Contentrain Migrate ends every run by writing `contentrain-handoff.json`
 * (the `MigrationHandoff` contract from @contentrain/types) at the project
 * root: what the source site used, what happened to each capability, the
 * open runtime offers (comments, forms, …), and — when the source had
 * comments — the `contentrain-comments@1` export inline or by URL.
 *
 * Studio's side of that contract:
 *   - read + validate the file from the repository (content branch first,
 *     then the default branch) when the repo is connected and on demand;
 *   - split it: the manifest (everything but the comments export) goes on
 *     the project row with `repository` filled in; the export itself never
 *     does — the row keeps only where to get it again (`studio_intake`);
 *   - summarise the manifest for the chat agent's request context and the
 *     overview card, including what Studio cannot take over;
 *   - land the comments export — re-read inline from the file, or fetched
 *     from its URL — through the same import path as the upload.
 */

import type { CommentsExport, HandoffComments, MigrationHandoff } from '@contentrain/types'
import { CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { GitProvider } from '~~/server/providers/git'
import type { CommentsImportReport } from './comment-import'
import { runCommentsImportChunked } from './comment-import'
import { isAllowedWebhookUrl } from './webhook-engine'

export const HANDOFF_FILENAME = 'contentrain-handoff.json'
/** GitHub's own blob ceiling — past this the file cannot be read, let alone parsed. */
export const HANDOFF_FILE_MAX_BYTES = 100 * 1024 * 1024
/**
 * What Studio keeps on the project row once the comments export is lifted
 * out. The largest real handoff seen (v2 cohort, 24 sites) is ~34 KB after
 * the split; 1 MB leaves room without letting a runaway field ride along on
 * every project read.
 */
export const HANDOFF_MANIFEST_MAX_BYTES = 1024 * 1024
/** Inline or fetched comments export, same ceiling as the URL fetch. */
export const EXPORT_MAX_BYTES = 50 * 1024 * 1024
/** `comments.unresolved` is one row per comment; the card and agent need the count, not the list. */
const STORED_UNRESOLVED_LIMIT = 100
/**
 * Capabilities Studio can actually run when Migrate offers them as
 * `studio_managed`. Anything else offered that way (search, ecommerce, …) is
 * reported as unsupported rather than shown as an open offer.
 */
export const STUDIO_MANAGED_CAPABILITIES: ReadonlySet<string> = new Set(['forms', 'comments'])

export interface HandoffValidationError {
  code: 'invalid_payload' | 'unsupported_version' | 'invalid_capabilities'
  detail?: string
}

/** Structural check of a handoff document; the contract's required keys only. */
export function validateMigrationHandoff(input: unknown): HandoffValidationError | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { code: 'invalid_payload' }
  const h = input as Partial<MigrationHandoff>
  if (typeof h.version !== 'number' || !Number.isFinite(h.version)) return { code: 'invalid_payload', detail: 'version' }
  if (h.version !== 1) return { code: 'unsupported_version', detail: String(h.version) }
  if (typeof h.site_url !== 'string' || !h.site_url) return { code: 'invalid_payload', detail: 'site_url' }
  if (typeof h.generated_at !== 'string' || Number.isNaN(Date.parse(h.generated_at))) return { code: 'invalid_payload', detail: 'generated_at' }
  if (!Array.isArray(h.capabilities)) return { code: 'invalid_capabilities' }
  for (const cap of h.capabilities) {
    if (!cap || typeof cap !== 'object' || typeof (cap as { key?: unknown }).key !== 'string' || typeof (cap as { disposition?: unknown }).disposition !== 'string')
      return { code: 'invalid_capabilities', detail: JSON.stringify(cap).slice(0, 80) }
  }
  if (h.comments !== undefined && (!h.comments || typeof h.comments !== 'object' || typeof h.comments.total !== 'number'))
    return { code: 'invalid_payload', detail: 'comments' }
  return null
}

/** Fill the fields only Studio knows: which repository the project ended up in. */
export function enrichMigrationHandoff<T extends MigrationHandoff>(handoff: T, project: { repo_full_name: string, default_branch?: string | null }): T {
  if (handoff.repository) return handoff
  const [owner = '', name = ''] = String(project.repo_full_name).split('/')
  if (!owner || !name) return handoff
  return {
    ...handoff,
    repository: { provider: 'github', owner, name, default_branch: project.default_branch || 'main' },
  }
}

// ─── Manifest / comments split ───

/**
 * Where the comments export lives. The export itself is never stored on the
 * project row; `inline` is re-read from `studio_intake.source` at import time.
 */
export type HandoffCommentsSource
  = | { kind: 'url', url: string }
    | { kind: 'inline', bytes: number }
    | { kind: 'none' }

/** Studio's own record of the intake, stored beside the manifest. Not part of the Migrate contract. */
export interface HandoffIntake {
  source: { path: string, ref: string }
  fileBytes: number
  manifestBytes: number
  comments: HandoffCommentsSource
  /** Set when the inline export is over `EXPORT_MAX_BYTES`: the manifest is kept, the import is not offered. */
  commentsTooLarge?: { bytes: number, limit: number }
  /** Length of `comments.unresolved` before it was trimmed for storage. */
  unresolvedTotal: number
}

/** What `projects.migration_handoff` holds: the manifest plus the intake record. */
export type StoredMigrationHandoff = MigrationHandoff & { studio_intake?: HandoffIntake }

export interface SplitMigrationHandoff {
  manifest: StoredMigrationHandoff
  manifestBytes: number
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * Lift the comments export out of the handoff. URL wins over inline (a
 * producer that publishes one means it for large sites); with neither the
 * source reads as "no export". `unresolved` is trimmed to a sample — its
 * length is kept in the intake record.
 */
export function splitMigrationHandoff(
  handoff: MigrationHandoff,
  source: { path: string, ref: string },
  fileBytes: number,
): SplitMigrationHandoff {
  const exp = handoff.comments?.export
  let comments: HandoffCommentsSource = { kind: 'none' }
  let commentsTooLarge: HandoffIntake['commentsTooLarge']
  if (exp?.url) {
    comments = { kind: 'url', url: exp.url }
  }
  else if (exp?.inline) {
    const bytes = jsonBytes(exp.inline)
    if (bytes > EXPORT_MAX_BYTES) commentsTooLarge = { bytes, limit: EXPORT_MAX_BYTES }
    else comments = { kind: 'inline', bytes }
  }

  const unresolved = handoff.comments?.unresolved
  const storedComments: HandoffComments | undefined = handoff.comments
    ? {
        ...handoff.comments,
        ...(exp ? { export: { format: exp.format, ...(exp.url ? { url: exp.url } : {}) } } : {}),
        ...(unresolved ? { unresolved: unresolved.slice(0, STORED_UNRESOLVED_LIMIT) } : {}),
      }
    : undefined

  const { comments: _omit, ...rest } = handoff
  const manifestWithoutIntake: MigrationHandoff = { ...rest, ...(storedComments ? { comments: storedComments } : {}) }
  const manifestBytes = jsonBytes(manifestWithoutIntake)
  const intake: HandoffIntake = {
    source,
    fileBytes,
    manifestBytes,
    comments,
    ...(commentsTooLarge ? { commentsTooLarge } : {}),
    unresolvedTotal: unresolved?.length ?? 0,
  }
  return { manifest: { ...manifestWithoutIntake, studio_intake: intake }, manifestBytes }
}

/** Name the field that pushed the manifest over its ceiling, for the error message. */
export function describeOversizedManifest(manifest: MigrationHandoff, manifestBytes: number): string {
  const largest = Object.entries(manifest)
    .filter(([key]) => key !== 'studio_intake')
    .map(([key, value]) => ({ key, bytes: jsonBytes(value) }))
    .sort((a, b) => b.bytes - a.bytes)[0]
  const head = `manifest ${formatBytes(manifestBytes)} > ${formatBytes(HANDOFF_MANIFEST_MAX_BYTES)}`
  return largest ? `${head}; largest field: ${largest.key} (${formatBytes(largest.bytes)})` : head
}

// ─── Summary ───

/**
 * - `offer_unsupported`: a `studio_managed` offer for a capability Studio has no runtime for.
 * - `runtime_unbound`: a capability Studio can run still needs a live service, and the handoff records no binding.
 */
export type MigrationHandoffIssue
  = | { code: 'offer_unsupported', capabilities: string[] }
    | { code: 'runtime_unbound', capabilities: string[] }
    | { code: 'preview_url_missing' }
    | { code: 'comments_export_too_large', detail: string }

export interface MigrationHandoffSummary {
  siteUrl: string
  generatedAt: string
  content?: { models: number, entries: number, locales: string[] }
  capabilities: Array<{ key: string, disposition: string, detail?: string }>
  /** Capabilities that need a live service — the ones Studio can take over. */
  needsRuntime: string[]
  offers: Array<{ capability: string, provider: string, supported: boolean, warning?: string }>
  comments?: { total: number, hasExport: boolean, source: HandoffCommentsSource['kind'], unresolved: number }
  notes: string[]
  previewUrl?: string
  /** What Studio cannot take over or cannot see — shown, never silently accepted. */
  issues: MigrationHandoffIssue[]
}

function commentsSourceOf(handoff: StoredMigrationHandoff): HandoffCommentsSource {
  if (handoff.studio_intake) return handoff.studio_intake.comments
  // Rows stored before the split still carry the export itself.
  const exp = handoff.comments?.export
  if (exp?.inline) return { kind: 'inline', bytes: 0 }
  if (exp?.url) return { kind: 'url', url: exp.url }
  return { kind: 'none' }
}

export function summarizeMigrationHandoff(handoff: StoredMigrationHandoff): MigrationHandoffSummary {
  const capabilities = (handoff.capabilities ?? []).map(c => ({ key: String(c.key), disposition: String(c.disposition), ...(c.detail ? { detail: c.detail } : {}) }))
  const needsRuntime = capabilities.filter(c => c.disposition === 'needs_runtime').map(c => c.key)
  const offers = (handoff.offers ?? []).map(o => ({
    capability: String(o.capability),
    provider: String(o.provider),
    supported: o.provider !== 'studio_managed' || STUDIO_MANAGED_CAPABILITIES.has(String(o.capability)),
    ...(o.warning ? { warning: o.warning } : {}),
  }))
  const commentsSource = commentsSourceOf(handoff)

  const issues: MigrationHandoffIssue[] = []
  const unsupported = [...new Set(offers.filter(o => !o.supported).map(o => o.capability))]
  if (unsupported.length) issues.push({ code: 'offer_unsupported', capabilities: unsupported })
  const unbound = needsRuntime.filter(key => STUDIO_MANAGED_CAPABILITIES.has(key))
  if (unbound.length && !handoff.runtime) issues.push({ code: 'runtime_unbound', capabilities: unbound })
  if (!handoff.preview_url) issues.push({ code: 'preview_url_missing' })
  const tooLarge = handoff.studio_intake?.commentsTooLarge
  if (tooLarge)
    issues.push({ code: 'comments_export_too_large', detail: `comments.export.inline ${formatBytes(tooLarge.bytes)} > ${formatBytes(tooLarge.limit)}` })

  return {
    siteUrl: handoff.site_url,
    generatedAt: handoff.generated_at,
    content: handoff.content_summary
      ? { models: handoff.content_summary.models, entries: handoff.content_summary.entries, locales: handoff.content_summary.locales ?? [] }
      : undefined,
    capabilities,
    needsRuntime,
    offers,
    comments: handoff.comments
      ? {
          total: handoff.comments.total,
          hasExport: commentsSource.kind !== 'none',
          source: commentsSource.kind,
          unresolved: handoff.studio_intake?.unresolvedTotal ?? handoff.comments.unresolved?.length ?? 0,
        }
      : undefined,
    notes: (handoff.notes ?? []).slice(0, 5),
    previewUrl: handoff.preview_url,
    issues,
  }
}

/** Compact block for the agent's per-request context (dynamic body — never the cached system prompt). */
export function renderMigrationHandoffForAgent(summary: MigrationHandoffSummary): string {
  const lines: string[] = ['## Migration (from WordPress)']
  lines.push(`- Source: ${summary.siteUrl} (handoff generated ${summary.generatedAt.slice(0, 10)})`)
  if (summary.content)
    lines.push(`- Migrated content: ${summary.content.models} models, ${summary.content.entries} entries${summary.content.locales.length ? ` [${summary.content.locales.join(', ')}]` : ''}`)
  const byDisposition = new Map<string, string[]>()
  for (const c of summary.capabilities) {
    const list = byDisposition.get(c.disposition) ?? []
    list.push(c.key)
    byDisposition.set(c.disposition, list)
  }
  for (const [disposition, keys] of byDisposition)
    lines.push(`- ${disposition}: ${keys.join(', ')}`)
  const openOffers = summary.offers.filter(o => o.supported)
  if (openOffers.length > 0)
    lines.push(`- Open offers: ${openOffers.map(o => `${o.capability} → ${o.provider}`).join('; ')}`)
  if (summary.comments)
    lines.push(`- Comments at source: ${summary.comments.total}${summary.comments.hasExport ? ' (export available — importable into Studio comments)' : ''}${summary.comments.unresolved ? `, ${summary.comments.unresolved} unresolved` : ''}`)
  for (const issue of summary.issues) {
    if (issue.code === 'offer_unsupported')
      lines.push(`- Not available in Studio (offered as studio_managed, no Studio runtime): ${issue.capabilities.join(', ')}`)
    else if (issue.code === 'runtime_unbound')
      lines.push(`- Runtime not bound yet (the generated site is not pointed at this project): ${issue.capabilities.join(', ')}`)
    else if (issue.code === 'preview_url_missing')
      lines.push('- No preview URL in the handoff')
    else if (issue.code === 'comments_export_too_large')
      lines.push(`- Comments export too large to import from the handoff (${issue.detail})`)
  }
  for (const note of summary.notes) lines.push(`- Note: ${note}`)
  return lines.join('\n')
}

// ─── Repository read + sync ───

async function readJsonIfPresent(git: GitProvider, path: string, ref: string): Promise<{ value: unknown, bytes: number } | undefined> {
  let raw: string
  try {
    raw = await git.readFile(path, ref)
  }
  catch {
    return undefined
  }
  if (!raw) return undefined
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes > HANDOFF_FILE_MAX_BYTES)
    throw createError({ statusCode: 413, message: errorMessage('migration.handoff_too_large', { detail: `file ${formatBytes(bytes)} > ${formatBytes(HANDOFF_FILE_MAX_BYTES)}` }) })
  try {
    return { value: JSON.parse(raw), bytes }
  }
  catch {
    throw createError({ statusCode: 422, message: errorMessage('migration.handoff_invalid', { detail: 'json' }) })
  }
}

/**
 * Find `contentrain-handoff.json` — Migrate writes it at the project root, so
 * try `{contentRoot}/` (when the content lives in a subdirectory) and the
 * repository root, on the content branch first and the default branch second.
 *
 * Paths are repository-relative: `git` must be an un-rooted provider (built
 * without `contentRoot`, as `resolveProjectContext` builds it). A rooted one
 * would prefix `contentRoot` a second time.
 */
export async function readMigrationHandoffFromRepo(
  git: GitProvider,
  contentRoot: string,
  defaultBranch: string,
): Promise<{ handoff: unknown, path: string, ref: string, bytes: number } | null> {
  const paths = [...new Set([contentRoot ? `${contentRoot}/${HANDOFF_FILENAME}` : HANDOFF_FILENAME, HANDOFF_FILENAME])]
  const refs = [...new Set([CONTENTRAIN_BRANCH, defaultBranch || 'main'])]
  for (const ref of refs) {
    for (const path of paths) {
      const found = await readJsonIfPresent(git, path, ref)
      if (found !== undefined) return { handoff: found.value, path, ref, bytes: found.bytes }
    }
  }
  return null
}

export interface SyncMigrationHandoffInput {
  projectId: string
  git: GitProvider
  contentRoot: string
  project: { repo_full_name: string, default_branch?: string | null }
}

export interface SyncMigrationHandoffResult {
  found: boolean
  handoff?: StoredMigrationHandoff
  summary?: MigrationHandoffSummary
  source?: { path: string, ref: string }
}

/** Read → validate → split → enrich → persist. A missing file clears nothing (a project may have been synced earlier). */
export async function syncMigrationHandoff(input: SyncMigrationHandoffInput): Promise<SyncMigrationHandoffResult> {
  const found = await readMigrationHandoffFromRepo(input.git, input.contentRoot, input.project.default_branch ?? 'main')
  if (!found) return { found: false }

  const invalid = validateMigrationHandoff(found.handoff)
  if (invalid)
    throw createError({ statusCode: 422, message: errorMessage('migration.handoff_invalid', { detail: invalid.detail ? `${invalid.code}: ${invalid.detail}` : invalid.code }) })

  const source = { path: found.path, ref: found.ref }
  const { manifest, manifestBytes } = splitMigrationHandoff(found.handoff as MigrationHandoff, source, found.bytes)
  if (manifestBytes > HANDOFF_MANIFEST_MAX_BYTES)
    throw createError({ statusCode: 413, message: errorMessage('migration.handoff_too_large', { detail: describeOversizedManifest(manifest, manifestBytes) }) })

  const handoff = enrichMigrationHandoff(manifest, input.project)
  await useDatabaseProvider().setProjectMigrationHandoff(input.projectId, handoff as unknown as Record<string, unknown>)
  return { found: true, handoff, summary: summarizeMigrationHandoff(handoff), source }
}

// ─── Comments from the handoff ───

async function fetchCommentsExport(url: string): Promise<unknown> {
  if (!isAllowedWebhookUrl(url))
    throw createError({ statusCode: 400, message: errorMessage('migration.export_url_blocked') })
  let response: Response
  try {
    response = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Contentrain-Studio/1.0' }, signal: AbortSignal.timeout(60_000) })
  }
  catch {
    throw createError({ statusCode: 400, message: errorMessage('migration.export_fetch_failed') })
  }
  if (!response.ok)
    throw createError({ statusCode: 400, message: errorMessage('migration.export_fetch_failed') })
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > EXPORT_MAX_BYTES)
    throw createError({ statusCode: 413, message: errorMessage('migration.export_too_large') })
  const text = await response.text()
  if (text.length > EXPORT_MAX_BYTES)
    throw createError({ statusCode: 413, message: errorMessage('migration.export_too_large') })
  try {
    return JSON.parse(text)
  }
  catch {
    throw createError({ statusCode: 400, message: errorMessage('migration.export_fetch_failed') })
  }
}

/** Re-read the handoff file the manifest came from and take its inline export. */
async function rereadInlineExport(git: GitProvider, source: { path: string, ref: string }): Promise<unknown> {
  const found = await readJsonIfPresent(git, source.path, source.ref)
  const inline = (found?.value as MigrationHandoff | undefined)?.comments?.export?.inline
  if (!inline) return undefined
  if (jsonBytes(inline) > EXPORT_MAX_BYTES)
    throw createError({ statusCode: 413, message: errorMessage('migration.export_too_large') })
  return inline
}

/**
 * Land the handoff's comments export through the regular import path.
 * Accepts the stored manifest (export located via `studio_intake`: URL
 * fetched, inline re-read from the repository with `git`) or a raw handoff
 * that still carries its export inline. Returns `null` when there is no
 * export to import.
 */
export async function importCommentsFromHandoff(
  projectId: string,
  workspaceId: string,
  handoff: StoredMigrationHandoff,
  defaultLocale: string,
  git?: GitProvider,
): Promise<CommentsImportReport | null> {
  let payload: unknown
  const inline = handoff.comments?.export?.inline
  const intake = handoff.studio_intake
  if (inline) {
    payload = inline
  }
  else if (intake?.comments.kind === 'url') {
    payload = await fetchCommentsExport(intake.comments.url)
  }
  else if (intake?.comments.kind === 'inline') {
    if (!git) return null
    payload = await rereadInlineExport(git, intake.source)
  }
  else if (!intake && handoff.comments?.export?.url) {
    payload = await fetchCommentsExport(handoff.comments.export.url)
  }
  if (!payload) return null
  return runCommentsImportChunked(projectId, workspaceId, payload as CommentsExport, defaultLocale)
}
