/**
 * The write of the media apply (`migration-media-apply.ts` plans it): one commit on a `cr/media/…` branch forked
 * from the snapshot the files were read at, then the project's own workflow decides. Auto-merge lands it
 * (`contentrain`, then `main`, or a pull request on a protected default branch), the same path every content save
 * and the bundle's site binding take; review leaves it pending for a reviewer. A write that landed since the read
 * makes the merge a conflict, never an overwrite.
 *
 * Two callers: the owner's apply (`POST …/migration/media/apply`, dry run first) and a bundle grant's import when it
 * finishes (`runMigrationMediaTick`), which never deletes the local files.
 *
 * The new addresses are keyless CDN delivery URLs, so the switch is refused while the CDN route would not serve
 * them (`publicMediaBlock`); a dry run reports the same reason as `blocked`.
 */
import { CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { DatabaseRow } from '../providers/database'
import type { GitProvider } from '../providers/git'
import { effectiveWorkflow } from './branch-approval'
import { getOrBuildBrainCache, invalidateBrainCache } from './brain-cache'
import { createContentEngine } from './content-engine'
import { createFeatureBranch, openWriteSnapshot, writeBase } from './content-engine/helpers'
import type { EngineMergeResult } from './content-engine/types'
import { STUDIO_AUTHOR } from './content-engine/types'
import { hasFeature } from './license'
import { readMigrationMediaManifest } from './migration-media'
import { planMigrationMediaApply } from './migration-media-apply'
import type { MigrationMediaApplyCounts } from './migration-media-apply'
import { publicMediaBase, publicMediaBlock } from './media-url'
import type { PublicMediaBlock } from './media-url'

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
  db: { listMigrationMediaItems: (jobId: string, state: 'done' | 'failed', limit: number) => Promise<DatabaseRow[]> }
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
  // Review projects hold it like any other change: it rewrites content and touches site files.
  if (effectiveWorkflow(brain.config?.workflow, hasFeature(plan, 'workflow.review')) === 'review')
    return { status: 'pending_review', counts, branch: branchName, commitSha: commit.sha }

  let merge: EngineMergeResult
  try {
    merge = await engine.mergeBranch(branchName)
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
  return { status: 'merged', counts, branch: branchName, commitSha: commit.sha, pullRequestUrl: merge.pullRequestUrl ?? null }
}
