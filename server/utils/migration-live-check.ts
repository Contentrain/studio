/**
 * The setup's last step: does the live site show a change made in Studio? Studio writes one small check file to the
 * site (`public/.well-known/contentrain-check.txt`, under the site's root) holding a fresh nonce, merged the way the
 * owner's click merges anything (`mergeOnClick`: on a review project the click is the approval), and then looks for
 * that nonce on the live site. Seen there, the host rebuilds the site from the repository, so every later change in
 * Studio reaches it too.
 *
 * - **One stable file.** Every check rewrites the same file with a new nonce; nothing piles up in the repository. It is
 *   the customer's to delete once the site is set up (the commit says so).
 * - **The fetch is guarded** (`fetchFromOrigin`): https only, the live site's own host, public addresses only (checked
 *   at connect time), same-host redirects only, a few KB, a short deadline. The address is the owner's, so it is
 *   untrusted input to a server-side fetch.
 * - Studio does not know every host's build delay, so a check that does not see the nonce yet is not a failure: the
 *   owner checks again, or says they see it (the manual fallback, `seenBy: 'owner'`).
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseProvider } from '../providers/database'
import type { GitProvider } from '../providers/git'
import { getOrBuildBrainCache, invalidateBrainCache } from './brain-cache'
import { mergeOnClick } from './click-approval'
import type { ClickApprover } from './click-approval'
import { createContentEngine } from './content-engine'
import { createFeatureBranch, openWriteSnapshot, writeBase } from './content-engine/helpers'
import type { EngineMergeResult } from './content-engine/types'
import { STUDIO_AUTHOR } from './content-engine/types'
import { projectPath, readMigrationMediaManifest } from './migration-media'
import type { MigrationSetupRecord } from './migration-setup'
import { fetchFromOrigin } from './origin-fetch'

/** Where the check file sits under the site's root, and where the live site serves it. */
export const LIVE_CHECK_FILE = 'public/.well-known/contentrain-check.txt'
export const LIVE_CHECK_URL_PATH = '.well-known/contentrain-check.txt'

/** The commit the customer's repository gets: what it does, in its own words. */
export const LIVE_CHECK_MESSAGE = 'contentrain: add a check file to see the live site update from Studio\n\n'
  + 'Studio looks for this file on your live site to confirm your host rebuilds the site when content changes.\n'
  + 'It changes nothing on your pages. You can delete it once your site is set up.'

/** The note on the approval a review project's check is merged with. */
export const LIVE_CHECK_APPROVAL_NOTE = 'check the live site'

export type LiveCheck = NonNullable<MigrationSetupRecord['live_check']>

export function liveCheckSource(nonce: string): string {
  return 'This file lets Contentrain Studio check that your live site shows changes made in Studio.\n'
    + 'You can delete it once your site is set up.\n\n'
    + `check: ${nonce}\n`
}

export interface WriteLiveCheckInput {
  db: Pick<DatabaseProvider, 'recordApproval'>
  git: GitProvider
  contentRoot: string
  projectId: string
  plan: string
  defaultBranch: string
  approver: ClickApprover
  now?: () => Date
}

/** Write a fresh check and merge it under the click; a conflict throws 409 (nothing was overwritten). */
export async function writeLiveCheck(input: WriteLiveCheckInput): Promise<LiveCheck> {
  const { git, contentRoot, projectId } = input
  const nonce = randomBytes(16).toString('hex')
  // The site's root: where Migrate's handoff says the site is (the repository root for a delivered site).
  const root = (await readMigrationMediaManifest(git, contentRoot, input.defaultBranch).catch(() => null))?.root ?? ''
  const engine = createContentEngine({ git, contentRoot, projectId })
  await engine.ensureContentBranch()
  const snapshot = await openWriteSnapshot(git)
  const { branchName } = await createFeatureBranch({ git, pathCtx: { contentRoot }, projectId, ensureContentBranch: () => Promise.resolve() }, 'studio', 'live-check')
  await git.applyPlan({ branch: branchName, changes: [{ path: projectPath(root, LIVE_CHECK_FILE), content: liveCheckSource(nonce) }], message: LIVE_CHECK_MESSAGE, author: STUDIO_AUTHOR, base: writeBase(snapshot) })

  const at = (input.now ?? (() => new Date()))().toISOString()
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  let merge: EngineMergeResult
  try {
    const landed = await mergeOnClick({ db: input.db, git, contentRoot, projectId, plan: input.plan, branch: branchName, brain, engine, approver: input.approver, note: LIVE_CHECK_APPROVAL_NOTE })
    if (landed.held) return { nonce, status: 'pending_review', branch: branchName, pullRequestUrl: null, at, seenAt: null, seenBy: null }
    merge = landed.merge
  }
  catch (error) {
    const status = error as { status?: number, statusCode?: number }
    if (status.status !== 409 && status.statusCode !== 409) throw error
    merge = { merged: false, sha: null, pullRequestUrl: null, conflict: true }
  }
  if (merge.conflict || (!merge.merged && !merge.pullRequestUrl)) {
    await git.deleteBranch(branchName).catch(() => {})
    throw createError({ statusCode: 409, message: errorMessage('migration.live_check_conflict') })
  }
  invalidateBrainCache(projectId)
  // A protected default branch: the check reaches the site when its pull request is merged.
  if (merge.pullRequestUrl) return { nonce, status: 'pull_request', branch: branchName, pullRequestUrl: merge.pullRequestUrl, at, seenAt: null, seenBy: null }
  return { nonce, status: 'merged', branch: branchName, pullRequestUrl: null, at, seenAt: null, seenBy: null }
}

/** The check file's address on the live site (a site under a path keeps it); null when the address is not https. */
export function liveCheckUrl(liveSiteUrl: string, nonce: string): string | null {
  let base: URL
  try {
    base = new URL(liveSiteUrl)
  }
  catch {
    return null
  }
  if (base.protocol !== 'https:' || base.username || base.password) return null
  base.search = ''
  base.hash = ''
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  const url = new URL(LIVE_CHECK_URL_PATH, base)
  // Past a cache in front of the site: every check asks for its own address.
  url.searchParams.set('check', nonce)
  return url.toString()
}

/** Whether the live site serves this check's nonce; any failure (not there yet, blocked, timed out) is `false`. */
export async function liveSiteShowsCheck(liveSiteUrl: string, nonce: string, fetch: typeof fetchFromOrigin = fetchFromOrigin): Promise<boolean> {
  const url = liveCheckUrl(liveSiteUrl, nonce)
  if (!url) return false
  try {
    const { buffer } = await fetch(url, url, {
      maxBytes: 4096,
      deadlineMs: 8000,
      idleMs: 5000,
      acceptType: type => type === '' || type.startsWith('text/') || type === 'application/octet-stream',
    })
    return buffer.toString('utf8').includes(`check: ${nonce}`)
  }
  catch {
    return false
  }
}
