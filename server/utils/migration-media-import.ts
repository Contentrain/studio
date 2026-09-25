/**
 * Moving a migration's media into Studio Media — the job (migration 037).
 *
 * `startMigrationMediaImport` reads `.contentrain/migrate/media.json` and the
 * branch's tree, and records one item per movable media file: in the tree at
 * the size the manifest lists, within the plan's file cap. Fonts, files the
 * branch does not hold as listed, and files over the cap are not queued; they
 * are returned as `skipped` for the caller to show (the preflight shows the
 * same lists before anything starts).
 *
 * `runMigrationMediaTick` is one worker step: claim the oldest claimable job
 * under a lease, import a batch of its pending items — blob → the same checks
 * as any upload (`inspectRepoMedia`) → `ingestMediaBytes` (dedupe, per-file
 * storage reservation) — settle each, and end the claim. When the workspace's
 * storage runs out the job pauses (`paused_quota`) with the rest pending;
 * resuming after an upgrade continues from there. A crash mid-batch leaves the
 * lease to expire; the next tick takes the job over, and only still-pending
 * items are touched, so nothing is imported twice.
 *
 * Files Migrate left at the old site (`studioRecommended`, migration 038) are
 * items too: fetched from the manifest's origin only (`fetchFromOrigin` —
 * host-locked, private addresses refused at connect, no redirect elsewhere,
 * size cap while streaming), then the same checks and ingest. A fetch that may
 * pass (timeout, 5xx, 429, connection) parks the file for a retry
 * (`MIGRATION_MEDIA_RETRY_DELAYS`) instead of failing it, and a batch stops
 * taking files once half the lease is spent, so a slow origin never outlives
 * the claim.
 */

import type { GitProvider } from '~~/server/providers/git'
import type { MediaProvider } from '~~/server/providers/media'
import type { Plan } from './license'
import { createMediaIngestContext, ingestMediaBytes } from './media-bulk-ingest'
import { inspectRepoMedia } from './media-ingest'
import type { MigrationMediaPreflight } from './migration-media'
import { fetchableFromOrigin, planMigrationMediaPreflight, projectPath, readMigrationMediaManifest } from './migration-media'
import { fetchFromOrigin, OriginFetchError } from './origin-fetch'
import type { OriginFetchOptions } from './origin-fetch'
import { resolveWorkspaceBilling } from './workspace-billing'

/** Files per claim: small enough to finish well inside the lease on a slow optimizer. */
export const MIGRATION_MEDIA_BATCH = 25
export const MIGRATION_MEDIA_LEASE_SECONDS = 5 * 60
/** A batch takes no new file past this: with one fetch's deadline after it, still inside the lease. */
export const MIGRATION_MEDIA_BATCH_BUDGET_MS = MIGRATION_MEDIA_LEASE_SECONDS * 1000 / 2
/** One fetch from the old site, redirects included. */
export const MIGRATION_MEDIA_FETCH_DEADLINE_MS = 60_000
/** Waits before each retry of a fetch that may pass; after the last, the file fails. */
export const MIGRATION_MEDIA_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000]

export interface StartMigrationMediaInput {
  projectId: string
  workspaceId: string
  userId: string
  plan: Plan
  usedBytes: number
  overageSettings?: Record<string, boolean>
  git: GitProvider
  contentRoot: string
  defaultBranch: string
}

export interface StartMigrationMediaResult {
  job: Record<string, unknown>
  created: boolean
  skipped: Pick<MigrationMediaPreflight, 'overSize' | 'missing' | 'fontsKept'> & {
    /** Files at the old site that are not fetched: over the file cap, or on another host. */
    onOrigin: Pick<MigrationMediaPreflight['onOrigin'], 'overSize' | 'offOrigin'>
  }
}

export async function startMigrationMediaImport(input: StartMigrationMediaInput): Promise<StartMigrationMediaResult> {
  const db = useDatabaseProvider()
  const found = await readMigrationMediaManifest(input.git, input.contentRoot, input.defaultBranch)
  if (!found)
    throw createError({ statusCode: 404, message: errorMessage('migration.media_manifest_missing') })
  if (typeof input.git.readBlob !== 'function')
    throw createError({ statusCode: 501, message: errorMessage('migration.media_repo_unsupported') })

  const tree = await input.git.getTree(found.ref)
  const preflight = planMigrationMediaPreflight({
    manifest: found.manifest,
    tree,
    plan: input.plan,
    usedBytes: input.usedBytes,
    overageSettings: input.overageSettings,
    root: found.root,
  })
  const blobs = new Map(tree.filter(e => e.type === 'blob').map(e => [e.path, e]))
  const blocked = new Set([...preflight.overSize.map(a => a.repoPath), ...preflight.missing.map(a => a.repoPath)])
  const items: Parameters<ReturnType<typeof useDatabaseProvider>['createMigrationMediaJob']>[0]['items'] = found.manifest.assets
    .filter(a => a.role === 'media' && !blocked.has(a.repoPath))
    .map(a => ({
      // Items carry the repository path — what the tree, the blob and a later deletion all use.
      repoPath: projectPath(found.root, a.repoPath),
      blobSha: blobs.get(projectPath(found.root, a.repoPath))!.sha,
      bytes: a.bytes,
      mime: a.mime,
      ...(a.width ? { width: Math.round(a.width) } : {}),
      ...(a.height ? { height: Math.round(a.height) } : {}),
      ...(a.alt ? { alt: a.alt } : {}),
    }))
  const originOverSize = new Set(preflight.onOrigin.overSize.map(f => f.url))
  for (const file of found.manifest.onOrigin) {
    if (!fetchableFromOrigin(found.manifest, file.url) || originOverSize.has(file.url)) continue
    // Keyed by its address: that is what content refers to it by, and what the rewrite looks for.
    items.push({ repoPath: file.url, sourceUrl: file.url, bytes: file.bytes ?? 0, mime: 'application/octet-stream' })
  }

  const manifestCommit = await input.git.getBranchSha?.(found.ref).catch(() => null) ?? null
  const { job, created } = await db.createMigrationMediaJob({
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    createdBy: input.userId,
    manifestRef: found.ref,
    manifestCommit,
    origin: found.manifest.origin ?? null,
    items,
  })
  return {
    job,
    created,
    skipped: {
      overSize: preflight.overSize,
      missing: preflight.missing,
      fontsKept: preflight.fontsKept,
      onOrigin: { overSize: preflight.onOrigin.overSize, offOrigin: preflight.onOrigin.offOrigin },
    },
  }
}

/** What the browser sees of a job. */
export function toMigrationMediaJobView(job: Record<string, unknown>, failures: Array<Record<string, unknown>> = []) {
  const total = Number(job.total ?? 0)
  const done = Number(job.done ?? 0)
  const failed = Number(job.failed ?? 0)
  return {
    id: String(job.id),
    status: String(job.status) as 'preparing' | 'queued' | 'running' | 'paused_quota' | 'done' | 'failed' | 'canceled',
    total,
    done,
    failed,
    deduped: Number(job.deduped ?? 0),
    pending: Math.max(0, total - done - failed),
    bytesDone: Number(job.bytes_done ?? 0),
    error: (job.error as string | null) ?? null,
    createdAt: String(job.created_at),
    finishedAt: (job.finished_at as string | null) ?? null,
    failures: failures.map(f => ({ repoPath: String(f.repo_path), error: (f.error as string | null) ?? null, statusCode: (f.status_code as number | null) ?? null })),
  }
}

export interface MigrationMediaTickDeps {
  /** Test seams — default to the project's Git provider, the media stack and the workspace's billing. */
  resolveGit?: (workspaceId: string, projectId: string) => Promise<GitProvider>
  media?: MediaProvider | null
  resolvePlan?: (workspaceId: string) => Promise<Plan | null>
  /** The fetch from the old site — only its resolver and address rule, for tests on a local server. */
  originFetch?: Pick<OriginFetchOptions, 'resolve' | 'isBlocked' | 'idleMs'> & { deadlineMs?: number }
  /** Clock for the batch budget. */
  clock?: () => number
}

export type MigrationMediaTickResult
  = | { claimed: false }
    | { claimed: true, jobId: string, settled: number, deferred: number, status: 'running' | 'paused_quota' | 'done' | 'failed' }

async function effectivePlan(workspaceId: string): Promise<Plan | null> {
  const db = useDatabaseProvider()
  const workspace = await db.getWorkspaceById(workspaceId, 'id, type, plan, overage_settings')
  if (!workspace) return null
  const billing = await resolveWorkspaceBilling(db, workspace as { id: string })
  return billing.effectivePlan
}

export async function runMigrationMediaTick(now = new Date(), deps: MigrationMediaTickDeps = {}): Promise<MigrationMediaTickResult> {
  const media = deps.media === undefined ? useMediaProvider() : deps.media
  // No media stack in this deployment: nothing can be imported, and no job is claimed and failed for it.
  if (!media) return { claimed: false }

  const db = useDatabaseProvider()
  const job = await db.claimMigrationMediaJob(now, MIGRATION_MEDIA_LEASE_SECONDS)
  if (!job) return { claimed: false }
  const jobId = String(job.id)
  const token = String(job.claim_token)
  const projectId = String(job.project_id)
  const workspaceId = String(job.workspace_id)
  let deferred = 0
  const finish = async (status: 'running' | 'paused_quota' | 'done' | 'failed', error: string | null, settled: number): Promise<MigrationMediaTickResult> => {
    await db.finishMigrationMediaJob(jobId, token, status, error, new Date())
    return { claimed: true, jobId, settled, deferred, status }
  }

  const plan = await (deps.resolvePlan ?? effectivePlan)(workspaceId)
  if (!plan || !hasFeature(plan, 'media.upload'))
    return finish('failed', errorMessage('media.upload_upgrade', getUpgradeParams(plan ?? 'starter')), 0)

  let git: GitProvider
  try {
    git = await (deps.resolveGit ?? (async (w, p) => (await resolveProjectContext(w, p)).git))(workspaceId, projectId)
  }
  catch (error) {
    return finish('failed', (error as Error)?.message ?? 'git_unavailable', 0)
  }
  const readBlob = git.readBlob?.bind(git)
  const uploadedBy = String(job.created_by ?? '')
  const ctx = await createMediaIngestContext({ projectId, workspaceId, plan, uploadedBy, source: 'repo', media })
  // A fetched file is recorded as fetched from a URL, like any other.
  const urlCtx = { ...ctx, source: 'url' as const }
  const origin = typeof job.origin === 'string' ? job.origin : null
  const clock = deps.clock ?? Date.now
  const started = clock()
  const items = await db.listPendingMigrationMediaItems(jobId, MIGRATION_MEDIA_BATCH, now)
  let settled = 0

  for (const item of items) {
    // Past half the lease: leave the rest for the next claim rather than risk outliving this one.
    if (clock() - started > MIGRATION_MEDIA_BATCH_BUDGET_MS) break
    const repoPath = String(item.repo_path)
    const sourceUrl = typeof item.source_url === 'string' ? item.source_url : null
    let result
    let stored: number | null = null
    try {
      if (sourceUrl) {
        if (!origin) throw createError({ statusCode: 400, message: errorMessage('media.origin_fetch_failed', { reason: 'off_origin' }) })
        const fetched = await fetchFromOrigin(sourceUrl, origin, {
          maxBytes: ctx.maxBytes,
          deadlineMs: deps.originFetch?.deadlineMs ?? MIGRATION_MEDIA_FETCH_DEADLINE_MS,
          ...deps.originFetch,
        })
        const remote = await inspectRepoMedia({ buffer: fetched.buffer, repoPath: new URL(fetched.url).pathname, maxBytes: ctx.maxBytes })
        stored = remote.buffer.length
        result = await ingestMediaBytes(urlCtx, { ref: sourceUrl, remote })
      }
      else {
        if (!readBlob) throw createError({ statusCode: 501, message: errorMessage('migration.media_repo_unsupported') })
        const buffer = await readBlob(String(item.blob_sha))
        const remote = await inspectRepoMedia({
          buffer,
          repoPath,
          declaredMime: String(item.mime),
          maxBytes: ctx.maxBytes,
          ...(item.width ? { width: Number(item.width) } : {}),
          ...(item.height ? { height: Number(item.height) } : {}),
        })
        result = await ingestMediaBytes(ctx, { ref: repoPath, remote, ...(item.alt ? { alt: String(item.alt) } : {}) })
      }
    }
    catch (error) {
      if (error instanceof OriginFetchError) {
        const reason = errorMessage('media.origin_fetch_failed', { reason: error.code })
        const attempts = Number(item.attempts ?? 0)
        if (error.retryable && attempts < MIGRATION_MEDIA_RETRY_DELAYS_MS.length) {
          const tries = await db.deferMigrationMediaItem({
            jobId,
            token,
            repoPath,
            error: reason,
            statusCode: error.status ?? null,
            retryAt: new Date(Date.now() + MIGRATION_MEDIA_RETRY_DELAYS_MS[attempts]!),
          }, new Date())
          if (tries === null) return { claimed: true, jobId, settled, deferred, status: 'running' }
          deferred++
          continue
        }
        result = { url: repoPath, ok: false, error: reason, statusCode: error.status ?? 400 }
      }
      else {
        const e = error as { message?: string, statusCode?: number }
        result = { url: repoPath, ok: false, error: e?.message ?? 'failed', statusCode: e?.statusCode }
      }
    }

    // Out of room: this file stays pending and the job waits for more storage — resumed, it retries this one first.
    if (!result.ok && result.statusCode === 403 && result.error === errorMessage('storage.quota_exceeded'))
      return finish('paused_quota', result.error, settled)

    const accepted = await db.settleMigrationMediaItem({
      jobId,
      token,
      repoPath,
      ok: result.ok,
      assetId: result.assetId ?? null,
      deliveryUrl: result.deliveryUrl ?? null,
      deduped: result.deduped ?? false,
      error: result.ok ? null : (result.error ?? 'failed'),
      statusCode: result.ok ? null : (result.statusCode ?? null),
      ...(result.ok && stored !== null ? { bytes: stored } : {}),
    }, new Date())
    // The lease was taken over (this batch outlived it): stop without touching the job again.
    if (!accepted) return { claimed: true, jobId, settled, deferred, status: 'running' }
    settled++
  }

  // Pending includes files parked for a retry: the job stays open until they are fetched or fail.
  const more = await db.listPendingMigrationMediaItems(jobId, 1)
  return finish(more.length > 0 ? 'running' : 'done', null, settled)
}
