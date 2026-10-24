/**
 * The write of the media apply (`migration-media-apply.ts` plans it): one commit on a `cr/media/…` branch forked
 * from the snapshot the files were read at, then the project's own workflow decides. Auto-merge lands it
 * (`contentrain`, then `main`, or a pull request on a protected default branch), the same path every content save
 * and the bundle's site binding take. A write that landed since the read makes the merge a conflict, never an
 * overwrite.
 *
 * On a review project the owner's or admin's click is the approval (F2), as Connect is for the site binding: it is
 * recorded against the branch's plan and tip (approver, role, `MEDIA_APPLY_APPROVAL_NOTE`), the branch is merged under
 * it and a receipt is kept. A policy that wants more than that one grant leaves it pending for its reviewers. With no
 * approver (the bundle's own apply, run by the worker or the sweep), review leaves it pending: nothing unattended
 * approves it.
 *
 * Two callers: the owner's apply (`POST …/migration/media/apply`, dry run first) and a bundle grant's import when it
 * finishes (`runMigrationMediaTick`), which never deletes the local files.
 *
 * The new addresses are keyless CDN delivery URLs, so the switch is refused while the CDN route would not serve
 * them (`publicMediaBlock`); a dry run reports the same reason as `blocked`.
 */
import { CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { DatabaseProvider, DatabaseRow } from '../providers/database'
import type { GitProvider } from '../providers/git'
import { gateForPlan } from './approval-gate'
import { effectiveWorkflow, recordMergeReceipt, resolveMergeApproval } from './branch-approval'
import { getOrBuildBrainCache, invalidateBrainCache } from './brain-cache'
import { createContentEngine } from './content-engine'
import { createFeatureBranch, openWriteSnapshot, writeBase } from './content-engine/helpers'
import type { EngineMergeResult } from './content-engine/types'
import { STUDIO_AUTHOR } from './content-engine/types'
import { actorFromEmail } from './execution-plan'
import { hasFeature } from './license'
import { readMigrationMediaManifest } from './migration-media'
import { planMigrationMediaApply } from './migration-media-apply'
import type { MigrationMediaApplyCounts } from './migration-media-apply'
import { publicMediaBase, publicMediaBlock } from './media-url'
import type { PublicMediaBlock } from './media-url'

/** The note on the approval a review project's media apply is merged with: the click that asked for it. */
export const MEDIA_APPLY_APPROVAL_NOTE = 'move this site\'s media to Studio'

/** Files listed by name in the commit a reviewer reads; the rest are counted. */
const LISTED = 50

/** Every imported item in one read — a migration's media, not an unbounded list. */
const IMPORTED_LIMIT = 50_000

/**
 * What a reviewer reads on the branch: the content rewrite in numbers, and every site file it touches by
 * name — studio.json and each local file it removes — so nothing outside content changes unseen.
 */
function commitMessage(counts: MigrationMediaApplyCounts, email: string | null): string {
  const lines = [
    'contentrain: move migrated media to Studio',
    '',
    `Content: ${counts.rewritten} references in ${counts.filesChanged} files now point at Studio Media.`,
  ]
  if (counts.drifted.length) lines.push(`Left as they are (changed since the migration): ${counts.drifted.length} references.`)
  if (counts.studioBinding === 'written') lines.push('Site file: studio.json (Studio binding for images, forms and comments).')
  if (counts.deletedPaths.length) {
    lines.push(`Removed ${counts.deletedPaths.length} local media files (nothing in the project refers to them any more):`)
    lines.push(...counts.deletedPaths.slice(0, LISTED).map(p => `  - ${p}`))
    if (counts.deletedPaths.length > LISTED) lines.push(`  … and ${counts.deletedPaths.length - LISTED} more`)
  }
  if (email) lines.push('', `Co-Authored-By: ${email}`)
  return lines.join('\n')
}

export interface ApplyMigrationMediaInput {
  db: Pick<DatabaseProvider, 'listMigrationMediaItems' | 'recordApproval'>
  git: GitProvider
  contentRoot: string
  projectId: string
  defaultBranch: string
  plan: string
  project: { cdn_enabled?: unknown, cdn_public_media?: unknown }
  /** The finished import whose delivery URLs the content is pointed at. */
  job: DatabaseRow
  dryRun: boolean
  deleteLocal: boolean
  /** Who asked, on the commit; null for the bundle's own apply. */
  authorEmail: string | null
  /**
   * The owner or admin whose click asked for it: on a review project the click is their approval. Absent for the
   * bundle's own apply, which stays for a reviewer.
   */
  approver?: { id: string, email: string, role: string | null, workspaceId: string }
}

export type ApplyMigrationMediaResult
  = | { status: 'dry_run', counts: MigrationMediaApplyCounts, blocked?: PublicMediaBlock }
    | { status: 'nothing_to_do', counts: MigrationMediaApplyCounts }
    | { status: 'pending_review', counts: MigrationMediaApplyCounts, branch: string, commitSha: string }
    | { status: 'merged', counts: MigrationMediaApplyCounts, branch: string, commitSha: string, pullRequestUrl: string | null }

export async function applyMigrationMedia(input: ApplyMigrationMediaInput): Promise<ApplyMigrationMediaResult> {
  const { git, contentRoot, projectId, plan, dryRun, deleteLocal } = input
  const blocked = publicMediaBlock(input.project, hasFeature(plan, 'cdn.delivery'))
  if (blocked && !dryRun) {
    if (blocked === 'plan')
      throw createError({ statusCode: 403, message: errorMessage('cdn.upgrade', getUpgradeParams(plan)), data: { blocked } })
    throw createError({ statusCode: 409, message: errorMessage(blocked === 'cdn_disabled' ? 'migration.media_cdn_disabled' : 'migration.media_public_off'), data: { blocked } })
  }
  const found = await readMigrationMediaManifest(git, contentRoot, input.defaultBranch)
  if (!found)
    throw createError({ statusCode: 404, message: errorMessage('migration.media_manifest_missing') })

  const engine = createContentEngine({ git, contentRoot, projectId })
  await engine.ensureContentBranch()
  const snapshot = await openWriteSnapshot(git)
  const imported = new Map((await input.db.listMigrationMediaItems(String(input.job.id), 'done', IMPORTED_LIMIT))
    .filter(item => item.delivery_url)
    .map(item => [String(item.repo_path), String(item.delivery_url)]))
  const pub = useRuntimeConfig().public
  const { changes, counts } = await planMigrationMediaApply({
    manifest: found.manifest,
    root: found.root,
    imported,
    read: path => snapshot.reader.readFile(path).catch(() => null),
    studio: { baseUrl: String(pub.siteUrl ?? ''), projectId, mediaBaseUrl: publicMediaBase(projectId) },
    deleteLocal,
    // Read only when a deletion is otherwise allowed: the whole project is searched for the local URLs first.
    listFiles: async () => (await git.getTree(snapshot.baseSha ?? CONTENTRAIN_BRANCH)).filter(e => e.type === 'blob'),
  })

  if (dryRun) return { status: 'dry_run', counts, ...(blocked ? { blocked } : {}) }
  if (changes.length === 0) return { status: 'nothing_to_do', counts }

  const { branchName } = await createFeatureBranch(
    { git, pathCtx: { contentRoot }, projectId, ensureContentBranch: () => Promise.resolve() },
    'media',
    'migration',
  )
  const commit = await git.applyPlan({
    branch: branchName,
    changes,
    message: commitMessage(counts, input.authorEmail),
    author: STUDIO_AUTHOR,
    base: writeBase(snapshot),
  })

  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const workflow = effectiveWorkflow(brain.config?.workflow, hasFeature(plan, 'workflow.review'))
  const startedAt = new Date().toISOString()
  let approval: Awaited<ReturnType<typeof resolveMergeApproval>> = null
  // Review projects hold it like any other change (it rewrites content and touches site files), until it is approved.
  if (workflow === 'review') {
    const held = { status: 'pending_review' as const, counts, branch: branchName, commitSha: commit.sha }
    if (!input.approver) return held
    const ask = () => resolveMergeApproval({ git, contentRoot, projectId, branch: branchName, workflow, policy: brain.approvalPolicy ?? null })
    const before = await ask()
    if (!before) return held
    await input.db.recordApproval({
      projectId,
      workspaceId: input.approver.workspaceId,
      target: branchName,
      gate: gateForPlan(before.decision),
      planHash: before.plan.plan_hash,
      commitSha: before.commitSha ?? null,
      approverId: input.approver.id,
      approverEmail: input.approver.email,
      approverRole: input.approver.role,
      note: MEDIA_APPLY_APPROVAL_NOTE,
    })
    approval = await ask()
    // A policy that asks for more than this one grant (more approvals, another role) keeps it for its reviewers.
    if (!approval?.decision.allowed) return held
  }

  let merge: EngineMergeResult
  try {
    merge = await engine.mergeBranch(branchName, approval?.commitSha ? { expectedHead: approval.commitSha } : {})
  }
  catch (error) {
    const status = error as { status?: number, statusCode?: number }
    if (status.status !== 409 && status.statusCode !== 409) throw error
    merge = { merged: false, sha: null, pullRequestUrl: null, conflict: true }
  }
  if (merge.conflict || (!merge.merged && !merge.pullRequestUrl)) {
    await git.deleteBranch(branchName).catch(() => {})
    throw createError({ statusCode: 409, message: errorMessage('migration.media_apply_conflict'), data: counts })
  }
  invalidateBrainCache(projectId)
  // The receipt says who let it in; it also clears the grant (`recordMergeReceipt`).
  if (approval && input.approver && merge.merged)
    await recordMergeReceipt({ projectId, workspaceId: input.approver.workspaceId, branch: branchName, approval, actor: actorFromEmail(input.approver.email), startedAt })
  return { status: 'merged', counts, branch: branchName, commitSha: commit.sha, pullRequestUrl: merge.pullRequestUrl ?? null }
}

/**
 * Whether a done import's new addresses are on the site: the apply planned against the DEFAULT branch (what the site
 * builds from, not `contentrain`) would rewrite nothing. A review held on `cr/media/*`, or a pull request into a
 * protected default branch, is not landed. Files Studio never took (over the file cap, failed) have no new address,
 * so they never hold it back. `studio.json` is not counted: the site binding owns it.
 */
export async function migrationMediaLanded(input: {
  db: Pick<ApplyMigrationMediaInput['db'], 'listMigrationMediaItems'>
  git: GitProvider
  contentRoot: string
  projectId: string
  defaultBranch: string
  job: DatabaseRow
}): Promise<boolean> {
  const found = await readMigrationMediaManifest(input.git, input.contentRoot, input.defaultBranch)
  if (!found) return false
  const imported = new Map((await input.db.listMigrationMediaItems(String(input.job.id), 'done', IMPORTED_LIMIT))
    .filter(item => item.delivery_url)
    .map(item => [String(item.repo_path), String(item.delivery_url)]))
  const pub = useRuntimeConfig().public
  const { counts } = await planMigrationMediaApply({
    manifest: found.manifest,
    root: found.root,
    imported,
    read: path => input.git.readFile(path, input.defaultBranch).catch(() => null),
    studio: { baseUrl: String(pub.siteUrl ?? ''), projectId: input.projectId, mediaBaseUrl: publicMediaBase(input.projectId) },
    deleteLocal: false,
  })
  return counts.rewritten === 0 && counts.relations === 0
}
