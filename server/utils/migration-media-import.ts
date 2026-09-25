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
 */

import type { GitProvider } from '~~/server/providers/git'
import type { MediaProvider } from '~~/server/providers/media'
import type { Plan } from './license'
import { createMediaIngestContext, ingestMediaBytes } from './media-bulk-ingest'
import { inspectRepoMedia } from './media-ingest'
import type { MigrationMediaPreflight } from './migration-media'
import { planMigrationMediaPreflight, readMigrationMediaManifest } from './migration-media'
import { resolveWorkspaceBilling } from './workspace-billing'

/** Files per claim: small enough to finish well inside the lease on a slow optimizer. */
export const MIGRATION_MEDIA_BATCH = 25
export const MIGRATION_MEDIA_LEASE_SECONDS = 5 * 60

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
  skipped: Pick<MigrationMediaPreflight, 'overSize' | 'missing' | 'fontsKept'>
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
  })
  const blobs = new Map(tree.filter(e => e.type === 'blob').map(e => [e.path, e]))
  const blocked = new Set([...preflight.overSize.map(a => a.repoPath), ...preflight.missing.map(a => a.repoPath)])
  const items = found.manifest.assets
    .filter(a => a.role === 'media' && !blocked.has(a.repoPath))
    .map(a => ({
      repoPath: a.repoPath,
      blobSha: blobs.get(a.repoPath)!.sha,
      bytes: a.bytes,
      mime: a.mime,
      ...(a.width ? { width: Math.round(a.width) } : {}),
      ...(a.height ? { height: Math.round(a.height) } : {}),
      ...(a.alt ? { alt: a.alt } : {}),
    }))

  const manifestCommit = await input.git.getBranchSha?.(found.ref).catch(() => null) ?? null
  const { job, created } = await db.createMigrationMediaJob({
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    createdBy: input.userId,
    manifestRef: found.ref,
    manifestCommit,
    items,
  })
  return {
    job,
    created,
    skipped: { overSize: preflight.overSize, missing: preflight.missing, fontsKept: preflight.fontsKept },
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
}

export type MigrationMediaTickResult
  = | { claimed: false }
    | { claimed: true, jobId: string, settled: number, status: 'running' | 'paused_quota' | 'done' | 'failed' }

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
  const finish = async (status: 'running' | 'paused_quota' | 'done' | 'failed', error: string | null, settled: number): Promise<MigrationMediaTickResult> => {
    await db.finishMigrationMediaJob(jobId, token, status, error, new Date())
    return { claimed: true, jobId, settled, status }
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
  if (typeof git.readBlob !== 'function')
    return finish('failed', errorMessage('migration.media_repo_unsupported'), 0)

  const ctx = await createMediaIngestContext({ projectId, workspaceId, plan, uploadedBy: String(job.created_by ?? ''), source: 'repo', media })
  const items = await db.listPendingMigrationMediaItems(jobId, MIGRATION_MEDIA_BATCH)
  let settled = 0

  for (const item of items) {
    const repoPath = String(item.repo_path)
    let result
    try {
      const buffer = await git.readBlob(String(item.blob_sha))
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
    catch (error) {
      const e = error as { message?: string, statusCode?: number }
      result = { url: repoPath, ok: false, error: e?.message ?? 'failed', statusCode: e?.statusCode }
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
    }, new Date())
    // The lease was taken over (this batch outlived it): stop without touching the job again.
    if (!accepted) return { claimed: true, jobId, settled, status: 'running' }
    settled++
  }

  const more = await db.listPendingMigrationMediaItems(jobId, 1)
  return finish(more.length > 0 ? 'running' : 'done', null, settled)
}
