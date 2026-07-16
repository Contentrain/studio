/**
 * CDN build runner — the shared completion path for both build triggers
 * (the GitHub push webhook and the manual "Rebuild now" endpoint).
 *
 * It runs one build, records the result on its `cdn_builds` row, and then
 * performs a bounded "catch-up": if the target branch advanced WHILE the build
 * was running (a push landed mid-build — its own webhook was turned away by the
 * single-in-flight claim), it claims and runs one more build at the new HEAD so
 * that mid-build pushes are never stranded. Catch-up builds are full rebuilds
 * (always correct) and are safe because the claim serializes them — only one
 * build per project runs at a time, so no destructive cleanup ever races
 * another build's uploads.
 *
 * The claim (DatabaseProvider.createCDNBuild) is what guarantees the mutual
 * exclusion across instances; this runner only decides WHETHER a follow-up is
 * warranted and drives it.
 */
import type { DatabaseProvider } from '../providers/database'
import type { GitProvider } from '../providers/git'
import type { CDNProvider } from '../providers/cdn'
import type { BuildProgressEvent, BuildResult } from './cdn-builder'
import { executeCDNBuild } from './cdn-builder'

// Hard ceiling on catch-up chaining so a branch under continuous pushes can't
// spin builds forever. Each iteration still reflects the latest HEAD, so the
// CDN converges; this only bounds how many times a single trigger chases it.
const MAX_CATCHUP_BUILDS = 5

export interface RunCDNBuildInput {
  db: DatabaseProvider
  projectId: string
  buildId: string
  git: GitProvider
  cdn: CDNProvider
  contentRoot: string
  commitSha: string
  branch: string
  changedPaths?: string[]
  fullRebuild?: boolean
  /** Progress sink for the initial (user-facing) build only — catch-up builds run silently. */
  onProgress?: (event: BuildProgressEvent) => void
}

/** Current head SHA of `branch`, or null if it can't be resolved. */
async function resolveBranchHead(git: GitProvider, branch: string): Promise<string | null> {
  try {
    const branches = await git.listBranches()
    return branches.find(b => b.name === branch)?.sha ?? null
  }
  catch {
    return null
  }
}

/** Execute a build, persist its result row, then chase any mid-build push. */
export async function runCDNBuild(input: RunCDNBuildInput): Promise<BuildResult> {
  const { db, projectId, git, cdn, contentRoot, branch } = input

  const result = await executeCDNBuild({
    projectId,
    buildId: input.buildId,
    git,
    cdn,
    contentRoot,
    commitSha: input.commitSha,
    branch,
    changedPaths: input.changedPaths,
    fullRebuild: input.fullRebuild,
    onProgress: input.onProgress,
  })

  await db.updateCDNBuild(input.buildId, {
    status: result.error ? 'failed' : 'success',
    file_count: result.filesUploaded,
    total_size_bytes: result.totalSizeBytes,
    changed_models: result.changedModels,
    build_duration_ms: result.durationMs,
    error_message: result.error ?? null,
    completed_at: new Date().toISOString(),
  })

  // Catch-up only after a clean build — a failed build is retried by the next
  // push, not by chasing HEAD on top of a broken state.
  if (!result.error)
    await catchUp({ db, projectId, git, cdn, contentRoot, branch, builtSha: input.commitSha, depth: 0 })

  return result
}

async function catchUp(args: {
  db: DatabaseProvider
  projectId: string
  git: GitProvider
  cdn: CDNProvider
  contentRoot: string
  branch: string
  builtSha: string
  depth: number
}): Promise<void> {
  if (args.depth >= MAX_CATCHUP_BUILDS) return

  const head = await resolveBranchHead(args.git, args.branch)
  // Branch unchanged (or unresolvable) → nothing stranded.
  if (!head || head === args.builtSha) return

  // Claim the in-flight slot for the follow-up. Null → another trigger already
  // grabbed it (e.g. the mid-build push's own retry, or a concurrent instance);
  // that build will chase HEAD, so we stop here.
  const build = await args.db.createCDNBuild({
    projectId: args.projectId,
    triggerType: 'webhook',
    commitSha: head,
    branch: args.branch,
  })
  if (!build?.id) return

  const result = await executeCDNBuild({
    projectId: args.projectId,
    buildId: build.id as string,
    git: args.git,
    cdn: args.cdn,
    contentRoot: args.contentRoot,
    commitSha: head,
    branch: args.branch,
    fullRebuild: true,
  })

  await args.db.updateCDNBuild(build.id as string, {
    status: result.error ? 'failed' : 'success',
    file_count: result.filesUploaded,
    total_size_bytes: result.totalSizeBytes,
    changed_models: result.changedModels,
    build_duration_ms: result.durationMs,
    error_message: result.error ?? null,
    completed_at: new Date().toISOString(),
  })

  if (!result.error)
    await catchUp({ ...args, builtSha: head, depth: args.depth + 1 })
}
