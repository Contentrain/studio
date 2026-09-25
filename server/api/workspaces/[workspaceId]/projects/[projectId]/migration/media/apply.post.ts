/**
 * Point the migrated site at its media in Studio, once the import is done:
 * rewrite every recorded reference to the Studio delivery URL, bind
 * `studio.json` (the starter's image `remotePatterns`), and — only when asked
 * and nothing can still point at them — delete the local `public/media/` files.
 * See `server/utils/migration-media-apply.ts`.
 *
 * One commit on a `cr/media/…` branch forked from the snapshot the files were
 * read at, then the project's own workflow decides: auto-merge lands it
 * (`contentrain`, then `main` — the same path every content save takes);
 * review leaves it pending for a reviewer, like any held change. A write that
 * landed since the read makes the merge a conflict, never an overwrite.
 *
 * Owner/admin only. `dryRun` defaults to true: the counts, nothing written.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/migration/media/apply
 *   { dryRun?: boolean, deleteLocal?: boolean }
 *   → 200 { status: 'dry_run' | 'nothing_to_do' | 'merged' | 'pending_review', counts, branch?, pullRequestUrl? }
 *   → 409 migration.media_import_not_done · migration.media_apply_conflict
 */

import type { EngineMergeResult } from '~~/server/utils/content-engine/types'
import { STUDIO_AUTHOR } from '~~/server/utils/content-engine/types'
import { createFeatureBranch, openWriteSnapshot, writeBase } from '~~/server/utils/content-engine/helpers'
import { effectiveWorkflow } from '~~/server/utils/branch-approval'
import { planMigrationMediaApply } from '~~/server/utils/migration-media-apply'
import { readMigrationMediaManifest } from '~~/server/utils/migration-media'
import { publicMediaBase } from '~~/server/utils/media-url'

/** Every imported item in one read — a migration's media, not an unbounded list. */
const IMPORTED_LIMIT = 50_000

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const body = await readBody<{ dryRun?: unknown, deleteLocal?: unknown }>(event).catch(() => null)
  const dryRun = body?.dryRun !== false
  const deleteLocal = body?.deleteLocal === true

  const job = await db.getLatestMigrationMediaJob(projectId)
  if (!job || job.status !== 'done')
    throw createError({ statusCode: 409, message: errorMessage('migration.media_import_not_done') })

  const rate = await checkRateLimit(`migration-media-apply:${session.user.id}`, 10, 60_000)
  if (!rate.allowed)
    throw createError({ statusCode: 429, message: errorMessage('migration.media_import_rate_limited') })

  const { git, contentRoot, workspace, project: row } = await resolveProjectContext(workspaceId, projectId)
  const found = await readMigrationMediaManifest(git, contentRoot, row.default_branch ?? 'main')
  if (!found)
    throw createError({ statusCode: 404, message: errorMessage('migration.media_manifest_missing') })

  const engine = createContentEngine({ git, contentRoot, projectId })
  await engine.ensureContentBranch()
  const snapshot = await openWriteSnapshot(git)
  const imported = new Map((await db.listMigrationMediaItems(String(job.id), 'done', IMPORTED_LIMIT))
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
  })

  if (dryRun) return { status: 'dry_run', counts }
  if (changes.length === 0) return { status: 'nothing_to_do', counts }

  const { branchName } = await createFeatureBranch(
    { git, pathCtx: { contentRoot }, projectId, ensureContentBranch: () => Promise.resolve() },
    'media',
    'migration',
  )
  const commit = await git.applyPlan({
    branch: branchName,
    changes,
    message: [
      'contentrain: move migrated media to Studio',
      '',
      `${counts.rewritten} references in ${counts.filesChanged} files; studio.json ${counts.studioBinding}; ${counts.deleted} local files removed`,
      '',
      `Co-Authored-By: ${session.user.email ?? ''}`,
    ].join('\n'),
    author: STUDIO_AUTHOR,
    base: writeBase(snapshot),
  })

  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace)
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
})
