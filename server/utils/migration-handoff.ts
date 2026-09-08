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
 *   - fill in what only Studio knows (`repository`) and keep the document on
 *     the project row;
 *   - summarise it for the chat agent's request context and the overview
 *     card;
 *   - land the comments export through the same import path as the upload.
 */

import type { CommentsExport, MigrationHandoff } from '@contentrain/types'
import { CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { GitProvider } from '~~/server/providers/git'
import type { CommentsImportReport } from './comment-import'
import { runCommentsImportChunked } from './comment-import'
import { isAllowedWebhookUrl } from './webhook-engine'

export const HANDOFF_FILENAME = 'contentrain-handoff.json'
const HANDOFF_MAX_BYTES = 5 * 1024 * 1024
const EXPORT_MAX_BYTES = 50 * 1024 * 1024

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
export function enrichMigrationHandoff(handoff: MigrationHandoff, project: { repo_full_name: string, default_branch?: string | null }): MigrationHandoff {
  if (handoff.repository) return handoff
  const [owner = '', name = ''] = String(project.repo_full_name).split('/')
  if (!owner || !name) return handoff
  return {
    ...handoff,
    repository: { provider: 'github', owner, name, default_branch: project.default_branch || 'main' },
  }
}

export interface MigrationHandoffSummary {
  siteUrl: string
  generatedAt: string
  content?: { models: number, entries: number, locales: string[] }
  capabilities: Array<{ key: string, disposition: string, detail?: string }>
  /** Capabilities that need a live service — the ones Studio can take over. */
  needsRuntime: string[]
  offers: Array<{ capability: string, provider: string, warning?: string }>
  comments?: { total: number, hasExport: boolean, unresolved: number }
  notes: string[]
  previewUrl?: string
}

export function summarizeMigrationHandoff(handoff: MigrationHandoff): MigrationHandoffSummary {
  const capabilities = (handoff.capabilities ?? []).map(c => ({ key: String(c.key), disposition: String(c.disposition), ...(c.detail ? { detail: c.detail } : {}) }))
  return {
    siteUrl: handoff.site_url,
    generatedAt: handoff.generated_at,
    content: handoff.content_summary
      ? { models: handoff.content_summary.models, entries: handoff.content_summary.entries, locales: handoff.content_summary.locales ?? [] }
      : undefined,
    capabilities,
    needsRuntime: capabilities.filter(c => c.disposition === 'needs_runtime').map(c => c.key),
    offers: (handoff.offers ?? []).map(o => ({ capability: String(o.capability), provider: String(o.provider), ...(o.warning ? { warning: o.warning } : {}) })),
    comments: handoff.comments
      ? {
          total: handoff.comments.total,
          hasExport: Boolean(handoff.comments.export?.inline || handoff.comments.export?.url),
          unresolved: handoff.comments.unresolved?.length ?? 0,
        }
      : undefined,
    notes: (handoff.notes ?? []).slice(0, 5),
    previewUrl: handoff.preview_url,
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
  if (summary.offers.length > 0)
    lines.push(`- Open offers: ${summary.offers.map(o => `${o.capability} → ${o.provider}`).join('; ')}`)
  if (summary.comments)
    lines.push(`- Comments at source: ${summary.comments.total}${summary.comments.hasExport ? ' (export available — importable into Studio comments)' : ''}${summary.comments.unresolved ? `, ${summary.comments.unresolved} unresolved` : ''}`)
  for (const note of summary.notes) lines.push(`- Note: ${note}`)
  return lines.join('\n')
}

// ─── Repository read + sync ───

async function readJsonIfPresent(git: GitProvider, path: string, ref: string): Promise<unknown | undefined> {
  let raw: string
  try {
    raw = await git.readFile(path, ref)
  }
  catch {
    return undefined
  }
  if (!raw) return undefined
  if (raw.length > HANDOFF_MAX_BYTES) throw createError({ statusCode: 413, message: errorMessage('migration.handoff_too_large') })
  try {
    return JSON.parse(raw)
  }
  catch {
    throw createError({ statusCode: 422, message: errorMessage('migration.handoff_invalid', { detail: 'json' }) })
  }
}

/**
 * Find `contentrain-handoff.json` — Migrate writes it at the project root, so
 * try `{contentRoot}/` (when the content lives in a subdirectory) and the
 * repository root, on the content branch first and the default branch second.
 */
export async function readMigrationHandoffFromRepo(
  git: GitProvider,
  contentRoot: string,
  defaultBranch: string,
): Promise<{ handoff: unknown, path: string, ref: string } | null> {
  const paths = [...new Set([contentRoot ? `${contentRoot}/${HANDOFF_FILENAME}` : HANDOFF_FILENAME, HANDOFF_FILENAME])]
  const refs = [...new Set([CONTENTRAIN_BRANCH, defaultBranch || 'main'])]
  for (const ref of refs) {
    for (const path of paths) {
      const handoff = await readJsonIfPresent(git, path, ref)
      if (handoff !== undefined) return { handoff, path, ref }
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
  handoff?: MigrationHandoff
  summary?: MigrationHandoffSummary
  source?: { path: string, ref: string }
}

/** Read → validate → enrich → persist. A missing file clears nothing (a project may have been synced earlier). */
export async function syncMigrationHandoff(input: SyncMigrationHandoffInput): Promise<SyncMigrationHandoffResult> {
  const found = await readMigrationHandoffFromRepo(input.git, input.contentRoot, input.project.default_branch ?? 'main')
  if (!found) return { found: false }

  const invalid = validateMigrationHandoff(found.handoff)
  if (invalid)
    throw createError({ statusCode: 422, message: errorMessage('migration.handoff_invalid', { detail: invalid.detail ? `${invalid.code}: ${invalid.detail}` : invalid.code }) })

  const handoff = enrichMigrationHandoff(found.handoff as MigrationHandoff, input.project)
  await useDatabaseProvider().setProjectMigrationHandoff(input.projectId, handoff as unknown as Record<string, unknown>)
  return { found: true, handoff, summary: summarizeMigrationHandoff(handoff), source: { path: found.path, ref: found.ref } }
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

/**
 * Land the handoff's comments export (inline first, URL second) through the
 * regular import path. Returns `null` when the handoff carries no export.
 */
export async function importCommentsFromHandoff(
  projectId: string,
  workspaceId: string,
  handoff: MigrationHandoff,
  defaultLocale: string,
): Promise<CommentsImportReport | null> {
  const exp = handoff.comments?.export
  if (!exp) return null
  const payload = exp.inline ?? (exp.url ? await fetchCommentsExport(exp.url) : undefined)
  if (!payload) return null
  return runCommentsImportChunked(projectId, workspaceId, payload as CommentsExport, defaultLocale)
}
