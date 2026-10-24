/**
 * Where a bundle grant's media move stands, and moving it on (053; P4 G2, G3).
 *
 * A bundle site's media moves to Studio on its own once the site is connected: the import starts for the grant
 * (`bindMigrateGrantSite` on Connect), and a done grant job is applied through the project's write path when the worker
 * closes it (`runMigrationMediaTick` → `applyGrantMigrationMedia`). `advanceGrantMedia` is the one place that decides
 * what happens next, from the project's LATEST import job whoever started it, and records it on the grant
 * (`media_state`):
 *
 * - no job: start one for the grant (`none` when the site has nothing to move); a failed start is tried again with
 *   backoff, up to `GRANT_MEDIA_MAX_ATTEMPTS`, and raises the ops alarm once after `GRANT_MEDIA_ALARM_ATTEMPTS`;
 * - open job: `importing`; `paused_quota` is resumed once the workspace has room for the next file, else it waits;
 * - done job: `connected` once its addresses are on the default branch (`migrationMediaLanded`); `review` while the
 *   apply is held on a `cr/media/*` branch or a pull request; else the grant's own job is applied (once per job), and
 *   an owner's job is the owner's to apply (`pending`; migration 052: never applied without their dry run);
 * - failed job: the grant's own is started again under the same retry rule; an owner's is the owner's (`pending`);
 * - canceled job: the owner's word, never started again (`pending`).
 *
 * The media apply on a review project stays under review: nothing here approves it (F2). Best-effort throughout: a
 * failure is recorded, never thrown at the caller.
 */
import type { DatabaseProvider, DatabaseRow, MigrateGrantMediaState } from '../providers/database'
import type { GitProvider } from '../providers/git'
import { reportMigrateGrantMediaAlarm } from './alert'
import { normalizeContentRoot } from './content-paths'
import type { Plan } from './license'
import { getPlanLimit, hasFeature } from './license'
import { migrationSignedOrigin } from './migrate-grant'
import { planMigrationMediaPreflight, readMigrationMediaManifest } from './migration-media'
import { applyGrantMigrationMedia, startMigrationMediaImport } from './migration-media-import'
import { migrationMediaLanded } from './migration-media-write'
import { getEffectiveLimit } from './overage'
import { useGitProvider } from './providers'
import { resolveWorkspaceBilling } from './workspace-billing'

export const GRANT_MEDIA_RETRY_BASE_MS = 30 * 60 * 1000
export const GRANT_MEDIA_MAX_ATTEMPTS = 5
/** The ops alarm goes out once, at this many failed attempts in a row. */
export const GRANT_MEDIA_ALARM_ATTEMPTS = 3

const OPEN = new Set(['preparing', 'queued', 'running'])
const GB = 1024 * 1024 * 1024

export function grantMediaNextAt(attempts: number, now: Date): Date | null {
  if (attempts >= GRANT_MEDIA_MAX_ATTEMPTS) return null
  return new Date(now.getTime() + GRANT_MEDIA_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

export type GrantMediaDb = Pick<DatabaseProvider,
  | 'getLatestMigrationMediaJob'
  | 'listPendingMigrationMediaItems'
  | 'listMigrationMediaItems'
  | 'resumeMigrationMediaJob'
  | 'setMigrateGrantMedia'
  | 'markMigrateGrantMediaAlerted'
  | 'getActivePaymentAccount'>

export interface AdvanceGrantMediaInput {
  db: GrantMediaDb
  grant: DatabaseRow
  /** `id, type, plan, overage_settings, github_installation_id, media_storage_bytes`. */
  workspace: DatabaseRow
  projectId: string
  repo: { owner: string, name: string }
  git: GitProvider
  contentRoot: string
  defaultBranch: string
  plan: string
  now?: () => Date
  /** The media stack is configured here (`useMediaProvider()`); the caller knows. */
  mediaStack: boolean
}

export interface AdvanceGrantMediaResult {
  state: MigrateGrantMediaState | null
  /** A job was started or resumed, or an apply was sent, on this pass. */
  acted: boolean
}

/** Decide and record where the grant's media stands; see the module doc. Null state: nothing recorded (no media stack or plan). */
export async function advanceGrantMedia(input: AdvanceGrantMediaInput): Promise<AdvanceGrantMediaResult> {
  const now = input.now ?? (() => new Date())
  const grantId = String(input.grant.id)
  const attempts = typeof input.grant.media_attempts === 'number' ? input.grant.media_attempts : 0
  const detail = (input.grant.media_detail as Record<string, unknown> | null) ?? {}
  const record = async (state: MigrateGrantMediaState, next: Record<string, unknown>, retry?: { attempts: number }) => {
    await input.db.setMigrateGrantMedia(grantId, {
      state,
      detail: next,
      attempts: retry ? retry.attempts : 0,
      nextAt: retry ? grantMediaNextAt(retry.attempts, now()) : null,
    })
  }
  const fail = async (code: string, extra: Record<string, unknown> = {}): Promise<AdvanceGrantMediaResult> => {
    const tries = attempts + 1
    await record('failed', { ...extra, code }, { attempts: tries })
    if (tries >= GRANT_MEDIA_ALARM_ATTEMPTS && input.grant.media_alerted_at == null && await input.db.markMigrateGrantMediaAlerted(grantId))
      reportMigrateGrantMediaAlarm({ grantId, projectId: input.projectId, repo: `${input.repo.owner}/${input.repo.name}`, code, attempts: tries })
    return { state: 'failed', acted: false }
  }
  // A `failed` grant is tried again only when its time has come; otherwise it waits as it is.
  const due = input.grant.media_state !== 'failed'
    || (attempts < GRANT_MEDIA_MAX_ATTEMPTS && (input.grant.media_next_at == null ? 0 : new Date(String(input.grant.media_next_at)).getTime()) <= now().getTime())

  try {
    if (!input.mediaStack || !hasFeature(input.plan, 'media.upload')) return { state: null, acted: false }
    const job = await input.db.getLatestMigrationMediaJob(input.projectId)
    const status = job ? String(job.status) : null
    const own = !!job && String(job.migrate_grant_id ?? '') === grantId

    if (!job || (status === 'failed' && own)) {
      if (!due) return { state: 'failed', acted: false }
      return await startForGrant(input, record, fail, job ? { previousJobId: String(job.id) } : {})
    }
    const known = kept(detail, String(job.id))
    // An owner's job counts its refusals the way the grant's start does, read once from the manifest and then kept.
    const refused = own || 'refusedTooLarge' in known ? {} : await ownerRefusedTooLarge(input, job)
    const jobDetail = { jobId: String(job.id), startedBy: own ? 'grant' : 'owner', ...known, ...refused }
    if (status && OPEN.has(status)) {
      await record('importing', jobDetail)
      return { state: 'importing', acted: false }
    }
    if (status === 'paused_quota') {
      if (await hasRoomForNext(input, job)) {
        const resumed = await input.db.resumeMigrationMediaJob(input.projectId, String(job.id))
        if (resumed) {
          await record('importing', { ...jobDetail, resumedAt: now().toISOString() })
          return { state: 'importing', acted: true }
        }
      }
      await record('paused_quota', jobDetail)
      return { state: 'paused_quota', acted: false }
    }
    // An owner's failed or canceled import, and a canceled grant job: the owner's to start again from the media card.
    if (status !== 'done') {
      await record('pending', { ...jobDetail, code: status === 'canceled' ? 'canceled' : 'job_failed' })
      return { state: 'pending', acted: false }
    }

    if (await migrationMediaLanded({ db: input.db, git: input.git, contentRoot: input.contentRoot, projectId: input.projectId, defaultBranch: input.defaultBranch, job })) {
      await record('connected', jobDetail)
      return { state: 'connected', acted: false }
    }
    const held = await heldApply(input.git, detail, String(job.id))
    if (held) {
      await record('review', { ...jobDetail, ...held })
      return { state: 'review', acted: false }
    }
    // The grant's own job, never applied (the worker's apply failed, or it closed before 053): apply it now, once.
    if (own && detail.appliedJobId !== String(job.id)) {
      if (!due) return { state: 'failed', acted: false }
      const outcome = await recordGrantMediaApply(input.db, input.grant, job, () => applyGrantMigrationMedia(job, input.plan as Plan), { attempts }, kept(detail, String(job.id)))
      return { state: outcome, acted: true }
    }
    await record('pending', jobDetail)
    return { state: 'pending', acted: false }
  }
  catch (error) {
    if (!due) return { state: 'failed', acted: false }
    return await fail('advance_failed', { message: String((error as Error)?.message ?? '').slice(0, 200) })
  }
}

async function startForGrant(
  input: AdvanceGrantMediaInput,
  record: (state: MigrateGrantMediaState, detail: Record<string, unknown>, retry?: { attempts: number }) => Promise<void>,
  fail: (code: string, extra?: Record<string, unknown>) => Promise<AdvanceGrantMediaResult>,
  extra: Record<string, unknown>,
): Promise<AdvanceGrantMediaResult> {
  const workspaceId = String(input.workspace.id)
  let started
  try {
    started = await startMigrationMediaImport({
      projectId: input.projectId,
      workspaceId,
      userId: String(input.grant.user_id),
      plan: input.plan as Plan,
      usedBytes: Number(input.workspace.media_storage_bytes ?? 0),
      overageSettings: (input.workspace.overage_settings as Record<string, boolean> | null) ?? {},
      git: input.git,
      contentRoot: input.contentRoot,
      defaultBranch: input.defaultBranch,
      signedOrigin: await migrationSignedOrigin(workspaceId, { repo_full_name: `${input.repo.owner}/${input.repo.name}` }),
      migrateGrantId: String(input.grant.id),
    })
  }
  catch (error) {
    // No manifest on the site: there is nothing for Studio to move.
    if ((error as { statusCode?: number })?.statusCode === 404) {
      await record('none', { ...extra, code: 'manifest_missing' })
      return { state: 'none', acted: false }
    }
    return fail('start_failed', { ...extra, message: String((error as Error)?.message ?? '').slice(0, 200) })
  }
  const { job, created, skipped } = started
  // Old-site files the import refused before fetching, as larger than the plan's file cap, that Migrate left there for
  // another cap (count, total): Migrate already counts its own `file-too-large` ones. Files refused while fetching
  // (sizes Migrate did not know) are the job's failed items; the status route adds those.
  const refusedTooLarge = refusedTooLargeOf(skipped.onOrigin.overSize)
  const jobDetail = { ...extra, jobId: String(job.id), startedBy: 'grant', refusedTooLarge }
  if (Number(job.total ?? 0) === 0 && String(job.status) === 'done') {
    // Nothing Studio takes (every file over the cap, or none at all): nothing to point at Studio either.
    await record('none', { ...jobDetail, code: 'nothing_to_move' })
    return { state: 'none', acted: created }
  }
  // A job with nothing left to fetch is done as it is recorded: no tick will close it, so it is applied here.
  if (created && String(job.status) === 'done') {
    const state = await recordGrantMediaApply(input.db, input.grant, job, () => applyGrantMigrationMedia(job, input.plan as Plan), { attempts: 0 }, { refusedTooLarge })
    return { state, acted: true }
  }
  await record('importing', jobDetail)
  return { state: 'importing', acted: created }
}

/**
 * Apply a done grant job and record the outcome on the grant: `connected` when it landed (or there was nothing to
 * rewrite), `review` when it waits for a reviewer or a pull request, `failed` (with backoff) when it was refused.
 * Shared by the worker that closes the job and the sweep that finds it unapplied.
 */
export async function recordGrantMediaApply(
  db: Pick<GrantMediaDb, 'setMigrateGrantMedia'>,
  grant: DatabaseRow,
  job: DatabaseRow,
  apply: () => ReturnType<typeof applyGrantMigrationMedia>,
  retry: { attempts: number },
  keep: Record<string, unknown> = kept((grant.media_detail as Record<string, unknown> | null) ?? {}, String(job.id)),
  now: () => Date = () => new Date(),
): Promise<MigrateGrantMediaState> {
  const grantId = String(grant.id)
  const base = { jobId: String(job.id), startedBy: 'grant', ...keep, appliedJobId: String(job.id) }
  try {
    const result = await apply()
    if (result.status === 'pending_review') {
      await db.setMigrateGrantMedia(grantId, { state: 'review', detail: { ...base, branch: result.branch ?? null }, attempts: 0, nextAt: null })
      return 'review'
    }
    if (result.status === 'merged' && result.pullRequestUrl) {
      await db.setMigrateGrantMedia(grantId, { state: 'review', detail: { ...base, branch: result.branch ?? null, pullRequestUrl: result.pullRequestUrl }, attempts: 0, nextAt: null })
      return 'review'
    }
    await db.setMigrateGrantMedia(grantId, { state: 'connected', detail: base, attempts: 0, nextAt: null })
    return 'connected'
  }
  catch (error) {
    // eslint-disable-next-line no-console -- ops visibility: the owner's apply card stays, nothing is lost
    console.error('[migrate-grant-media] grant apply failed', { grantId, jobId: String(job.id), message: (error as Error)?.message })
    const attempts = retry.attempts + 1
    const code = String((error as { data?: { blocked?: unknown } })?.data?.blocked ?? (error as { statusCode?: number })?.statusCode ?? 'apply_failed')
    // Not marked applied: the sweep sends it again when its time comes.
    await db.setMigrateGrantMedia(grantId, { state: 'failed', detail: { jobId: String(job.id), startedBy: 'grant', ...keep, code: `apply_${code}` }, attempts, nextAt: grantMediaNextAt(attempts, now()) })
    return 'failed'
  }
}

/** What a job's record keeps from one pass to the next: the refusal count taken when the grant started it. */
/**
 * Of the old-site files Migrate offered (its count-cap and total-cap rows), how many are larger than the plan takes
 * for one file. Its own `file-too-large` rows are never offered, and Migrate counts them itself.
 */
export function refusedTooLargeOf(overSize: Array<{ reason: string }>): number {
  return overSize.filter(f => f.reason !== 'file-too-large').length
}

/** The same count for a job the owner started, from the manifest on the site and the plan; nothing when unreadable. */
async function ownerRefusedTooLarge(input: AdvanceGrantMediaInput, job: DatabaseRow): Promise<{ refusedTooLarge?: number }> {
  try {
    const found = await readMigrationMediaManifest(input.git, input.contentRoot, input.defaultBranch)
    if (!found) return {}
    const preflight = planMigrationMediaPreflight({
      manifest: found.manifest,
      tree: [],
      plan: input.plan as Plan,
      usedBytes: 0,
      root: found.root,
      signedOrigin: typeof job.origin === 'string' ? job.origin : null,
    })
    return { refusedTooLarge: refusedTooLargeOf(preflight.onOrigin.overSize) }
  }
  catch {
    return {}
  }
}

function kept(detail: Record<string, unknown>, jobId: string): Record<string, unknown> {
  return detail.jobId === jobId && typeof detail.refusedTooLarge === 'number' ? { refusedTooLarge: detail.refusedTooLarge } : {}
}

/** The workspace has room for the paused job's next file (or no storage cap at all). */
async function hasRoomForNext(input: AdvanceGrantMediaInput, job: DatabaseRow): Promise<boolean> {
  const base = getPlanLimit(input.plan, 'media.storage_gb') * GB
  const limit = getEffectiveLimit(base, 'media.storage_gb', (input.workspace.overage_settings as Record<string, boolean> | null) ?? {})
  if (!(limit > 0) || !Number.isFinite(limit)) return true
  const used = Number(input.workspace.media_storage_bytes ?? 0)
  const [next] = await input.db.listPendingMigrationMediaItems(String(job.id), 1)
  // A file fetched from the old site has no size until it is fetched: room for anything at all is enough to try.
  const needed = Math.max(1, Number(next?.bytes ?? 0))
  return used + needed <= limit
}

/**
 * The apply is held for a person: a `cr/media/*` branch is still there (a reviewer, or the owner's own apply), or the
 * grant's apply opened a pull request into a protected default branch (not landed, by the check above).
 */
async function heldApply(git: GitProvider, detail: Record<string, unknown>, jobId: string): Promise<Record<string, unknown> | null> {
  if (detail.appliedJobId === jobId && typeof detail.pullRequestUrl === 'string')
    return { appliedJobId: jobId, pullRequestUrl: detail.pullRequestUrl, ...(typeof detail.branch === 'string' ? { branch: detail.branch } : {}) }
  for (const branch of await git.listBranches('cr/media/')) {
    // A merged branch not cleaned up yet holds nothing.
    if (await git.isMerged(branch.name)) continue
    return { branch: branch.name, ...(detail.appliedJobId === jobId ? { appliedJobId: jobId } : {}) }
  }
  return null
}

export interface GrantMediaSweepSummary {
  checked: number
  acted: number
  failed: number
  alarms: number
}

type SweepDb = GrantMediaDb & Pick<DatabaseProvider, 'listMigrateGrantMediaWork' | 'getWorkspaceById'>

/** One pass over the grants whose media is not settled (`listMigrateGrantMediaWork`). */
export async function sweepMigrateGrantMedia(input: { db: SweepDb, mediaStack: boolean, now?: () => Date, limit?: number, advance?: typeof advanceGrantMedia }): Promise<GrantMediaSweepSummary> {
  const advance = input.advance ?? advanceGrantMedia
  const rows = await input.db.listMigrateGrantMediaWork(input.limit ?? 50, GRANT_MEDIA_MAX_ATTEMPTS)
  const summary: GrantMediaSweepSummary = { checked: rows.length, acted: 0, failed: 0, alarms: 0 }
  if (!input.mediaStack) return summary
  for (const row of rows) {
    const workspace = await input.db.getWorkspaceById(row.workspace_id as string, 'id, type, plan, overage_settings, github_installation_id, media_storage_bytes')
    const installation = typeof workspace?.github_installation_id === 'number' ? workspace.github_installation_id : null
    if (!workspace || !installation) continue
    const repo = { owner: String(row.repo_owner), name: String(row.repo_name) }
    const git = useGitProvider({ installationId: installation, owner: repo.owner, repo: repo.name })
    const plan = (await resolveWorkspaceBilling(input.db, workspace as Parameters<typeof resolveWorkspaceBilling>[1])).effectivePlan
    const defaultBranch = (row.project_default_branch as string | null) ?? await git.getDefaultBranch()
    const result = await advance({
      db: input.db,
      grant: row,
      workspace,
      projectId: row.project_id as string,
      repo,
      git,
      contentRoot: normalizeContentRoot((row.project_content_root as string | null) ?? ''),
      defaultBranch,
      plan,
      mediaStack: input.mediaStack,
      ...(input.now ? { now: input.now } : {}),
    })
    if (result.acted) summary.acted++
    if (result.state === 'failed') summary.failed++
  }
  return summary
}
