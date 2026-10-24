/**
 * Where the setup of a migrated project stands (the setup wizard): four steps after "connected", each `done`,
 * `waiting` (Studio or a reviewer is on it), `needs_you` (one click of the owner's moves it on) or `skipped`, read from
 * the state each step already has. Nothing here is a second copy of that state: the site binding is the grant's (049),
 * the comments are the project's, the media move is the import job's and the grant's (053); the setup record (054,
 * `projects.migration_setup`) adds only what nothing else knows: a step the owner skipped, the outcome of the apply a
 * Move click asked for, the live-site check.
 */
import type { DatabaseRow, MigrateGrantMediaState } from '../providers/database'

export const MIGRATION_SETUP_STEPS = ['forms', 'comments', 'images', 'live'] as const
export type MigrationSetupStep = typeof MIGRATION_SETUP_STEPS[number]
export type MigrationSetupStepState = 'done' | 'waiting' | 'needs_you' | 'skipped'

/** What the setup record holds (054); every key optional, merged key by key (`mergeProjectMigrationSetup`). */
export interface MigrationSetupRecord {
  skip_forms?: boolean | null
  skip_comments?: boolean | null
  skip_images?: boolean | null
  skip_live?: boolean | null
  /** The apply a Move click asked for, as the worker that closed the job left it. */
  media_apply?: { jobId: string, status: 'merged' | 'pull_request' | 'pending_review' | 'nothing_to_do' | 'failed', branch?: string | null, pullRequestUrl?: string | null, code?: string, at: string } | null
  /** The last test change: its nonce (what the live site must serve), where it went, and when it was seen. */
  live_check?: { nonce: string, status: 'merged' | 'pull_request' | 'pending_review', branch?: string | null, pullRequestUrl?: string | null, at: string, seenAt?: string | null, seenBy?: 'fetch' | 'owner' | null } | null
  completed_at?: string | null
}

export function readMigrationSetupRecord(value: unknown): MigrationSetupRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MigrationSetupRecord : {}
}

const OPEN_JOB = new Set(['preparing', 'queued', 'running'])

export interface MigrationSetupFacts {
  record: MigrationSetupRecord
  /** The grant's site binding (049): its state and detail; null state when it was never tried. */
  binding: { state: string | null, detail: Record<string, unknown> }
  comments: { imported: number, export: 'ready' | 'unavailable' | 'imported' | 'expired' | null, atSource: number, sourceExport: boolean }
  /** The project's latest import job, the grant's media record (053), and whether the site has a media manifest at all. */
  media: { job: DatabaseRow | null, grantState: MigrateGrantMediaState | null, grantDetail: Record<string, unknown>, manifest: boolean }
}

export interface MigrationSetupStepView {
  step: MigrationSetupStep
  state: MigrationSetupStepState
  /** Why, for the copy: one code per step state (see each step below). */
  reason: string
  /** A branch or a pull request the step waits on, for the "review it" link. */
  branch?: string | null
  pullRequestUrl?: string | null
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** Forms and comments run with Studio: the site binding (studio.json), the one switch Connect already flips. */
function formsStep(facts: MigrationSetupFacts): MigrationSetupStepView {
  const { state, detail } = facts.binding
  if (state === 'written' || state === 'partial') return { step: 'forms', state: 'done', reason: state === 'partial' ? 'over_limit' : 'bound' }
  // Skipping never unbinds: it is offered, and counts, only while nothing is bound.
  if (facts.record.skip_forms) return { step: 'forms', state: 'skipped', reason: 'skipped' }
  if (state === 'pr_open') {
    const pullRequestUrl = str(detail.prUrl)
    // A pull request into a protected branch waits for GitHub; a review branch waits for the owner's approval.
    if (pullRequestUrl) return { step: 'forms', state: 'waiting', reason: 'pull_request', pullRequestUrl }
    return { step: 'forms', state: 'needs_you', reason: 'review', branch: str(detail.branch) }
  }
  if (state === 'conflict') return { step: 'forms', state: 'needs_you', reason: 'conflict' }
  if (state === 'failed') return { step: 'forms', state: 'needs_you', reason: 'failed' }
  return { step: 'forms', state: 'needs_you', reason: 'unbound' }
}

/** The old site's comments: imported, ready to import, or none to bring (none at the source, or the export is gone). */
function commentsStep(facts: MigrationSetupFacts): MigrationSetupStepView {
  const c = facts.comments
  if (c.imported > 0 || c.export === 'imported') return { step: 'comments', state: 'done', reason: 'imported' }
  if (facts.record.skip_comments) return { step: 'comments', state: 'skipped', reason: 'skipped' }
  if (c.export === 'ready' || (c.export === null && c.sourceExport && c.atSource > 0)) return { step: 'comments', state: 'needs_you', reason: 'ready' }
  return { step: 'comments', state: 'done', reason: c.export === 'expired' ? 'expired' : 'none' }
}

/**
 * The images: moved (the apply landed), on their way (importing, or the apply held for a reviewer or a pull request),
 * or the owner's click (start the move, approve the held apply, room for a paused one, a failed one again).
 */
function imagesStep(facts: MigrationSetupFacts): MigrationSetupStepView {
  const { job, grantState, grantDetail, manifest } = facts.media
  const jobId = job ? String(job.id) : null
  const status = job ? String(job.status) : null
  const held = (reason: string, branch: unknown, pr: unknown): MigrationSetupStepView => {
    const pullRequestUrl = str(pr)
    // A pull request waits for GitHub; a held branch is the owner's to approve (their click is the approval, #488).
    return pullRequestUrl
      ? { step: 'images', state: 'waiting', reason: 'pull_request', pullRequestUrl }
      : { step: 'images', state: 'needs_you', reason, branch: str(branch) }
  }

  // What the click's apply did, for this job: the freshest word there is.
  const applied = facts.record.media_apply
  if (applied && applied.jobId === jobId) {
    if (applied.status === 'merged' || applied.status === 'nothing_to_do') return { step: 'images', state: 'done', reason: 'moved' }
    if (applied.status === 'pull_request' || applied.status === 'pending_review') return held('review', applied.branch, applied.pullRequestUrl)
    // A failed apply (a conflict removed its branch) is asked for again, unless the grant's own apply landed since.
    if (applied.status === 'failed' && grantState !== 'connected') return { step: 'images', state: 'needs_you', reason: 'apply_failed' }
  }
  // The grant's record, when it is about this job (or there is no job): the sweep keeps it.
  const grantJob = str(grantDetail.jobId)
  if (grantState && (grantJob === jobId || !job)) {
    if (grantState === 'connected') return { step: 'images', state: 'done', reason: 'moved' }
    if (grantState === 'none') return { step: 'images', state: 'done', reason: 'nothing' }
    if (grantState === 'review') return held('review', grantDetail.branch, grantDetail.pullRequestUrl)
  }
  if (facts.record.skip_images) return { step: 'images', state: 'skipped', reason: 'skipped' }
  if (!job) return manifest ? { step: 'images', state: 'needs_you', reason: 'ready' } : { step: 'images', state: 'done', reason: 'nothing' }
  if (status && OPEN_JOB.has(status)) return { step: 'images', state: 'waiting', reason: 'importing' }
  if (status === 'paused_quota') return { step: 'images', state: 'needs_you', reason: 'paused_quota' }
  if (status === 'done') {
    // Done and not applied: a Move click the worker has not reached yet waits; otherwise the owner's to apply.
    if (job.apply_approver && applied?.jobId !== jobId) return { step: 'images', state: 'waiting', reason: 'applying' }
    return { step: 'images', state: 'needs_you', reason: 'apply_pending' }
  }
  return { step: 'images', state: 'needs_you', reason: 'failed' }
}

/** The live site shows a change from Studio: the test change was seen there (fetched, or the owner said so). */
function liveStep(facts: MigrationSetupFacts): MigrationSetupStepView {
  const check = facts.record.live_check
  if (check?.seenAt) return { step: 'live', state: 'done', reason: 'checked' }
  if (facts.record.skip_live) return { step: 'live', state: 'skipped', reason: 'no_host' }
  if (check && check.status !== 'merged') return check.pullRequestUrl
    ? { step: 'live', state: 'waiting', reason: 'pull_request', pullRequestUrl: check.pullRequestUrl }
    : { step: 'live', state: 'needs_you', reason: 'review', branch: check.branch ?? null }
  return { step: 'live', state: 'needs_you', reason: check ? 'not_seen' : 'unchecked' }
}

export function migrationSetupSteps(facts: MigrationSetupFacts): MigrationSetupStepView[] {
  return [formsStep(facts), commentsStep(facts), imagesStep(facts), liveStep(facts)]
}

/** Every step done or skipped: the setup is over and the wizard does not open again. */
export function migrationSetupComplete(steps: MigrationSetupStepView[]): boolean {
  return steps.every(s => s.state === 'done' || s.state === 'skipped')
}
