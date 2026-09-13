/**
 * Where the content branch stands against the repository's own branch.
 *
 * Studio has always known this at exactly one moment — the instant it tried to
 * advance `main` after a merge — and only as a single bit: `blocked_diverged`.
 * That is the answer to "did this merge's advance work", not to "is my content
 * on my site's branch", which is the question someone actually has when the
 * site does not show what Studio does.
 *
 * So the reading is standing and it has four states, because there are four
 * situations and they call for different things:
 *
 * - `in_sync` — the branches are the same commit. Nothing to do.
 * - `content_ahead` — content has landed that the base branch does not carry
 *   yet. Ordinary and transient: the advance runs at the end of a turn, so a
 *   read taken mid-turn sees this and it resolves itself.
 * - `base_ahead` — someone pushed to the base branch and the content branch
 *   has nothing of its own. **This is the fast-forward case** and the only
 *   state where syncing is mechanical: no reconcile, no decision, no conflict.
 * - `diverged` — both sides carry commits the other does not. A merge's
 *   advance falls back to a pull request here, and that is a person's problem.
 *
 * `unknown` is reported rather than guessed: a provider without `getMergeBase`
 * (the capability is optional) and a repo with no common history are both real,
 * and answering "in_sync" for either would be a lie in the reassuring
 * direction.
 *
 * Derived from two primitives that every provider has to have anyway —
 * branch tips and a merge base — rather than a host's compare endpoint, so it
 * does not become a second thing GitHub can do that GitLab cannot.
 */

import { CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { GitProvider } from '../providers/git'
import type { ContentSyncReport } from '../../shared/utils/content-sync'
import { getRedis } from './redis'

/**
 * Two minutes.
 *
 * Short because this changes on every merge and on every push by anyone, and
 * a stale "in sync" is the one answer that costs someone their afternoon. Not
 * zero because the sidebar asks for it on every project open, and it is two
 * API calls.
 */
const CACHE_TTL_MS = 2 * 60 * 1000
const CACHE_TTL_SECONDS = Math.ceil(CACHE_TTL_MS / 1000)
const REDIS_PREFIX = 'csync:'

const memoryCache = new Map<string, { report: ContentSyncReport, expiresAt: number }>()

async function readCache(projectId: string): Promise<ContentSyncReport | undefined> {
  const r = getRedis()
  if (r) {
    try {
      const raw = await r.get(`${REDIS_PREFIX}${projectId}`)
      if (raw) return JSON.parse(raw) as ContentSyncReport
      return undefined
    }
    catch {
      // Redis read failed — fall through to memory.
    }
  }
  const hit = memoryCache.get(projectId)
  if (!hit) return undefined
  if (hit.expiresAt < Date.now()) {
    memoryCache.delete(projectId)
    return undefined
  }
  return hit.report
}

async function writeCache(projectId: string, report: ContentSyncReport): Promise<void> {
  const r = getRedis()
  if (r) {
    try {
      await r.set(`${REDIS_PREFIX}${projectId}`, JSON.stringify(report), 'EX', CACHE_TTL_SECONDS)
      return
    }
    catch {
      // Fall through to memory.
    }
  }
  memoryCache.set(projectId, { report, expiresAt: Date.now() + CACHE_TTL_MS })
}

/**
 * Drop the cached reading.
 *
 * Called where the answer is known to have changed: after a merge advances (or
 * fails to advance) the base branch, and when a push webhook says someone
 * moved a branch from outside Studio. The TTL is the floor, not the mechanism —
 * without these the state is right eventually, which is not the same as being
 * right when someone looks.
 */
export async function invalidateContentSync(projectId: string): Promise<void> {
  memoryCache.delete(projectId)
  const r = getRedis()
  if (!r) return
  try {
    await r.del(`${REDIS_PREFIX}${projectId}`)
  }
  catch {
    // A stale entry expires on its own within the TTL.
  }
}

function unknown(baseBranch: string, contentSha: string | null, baseSha: string | null): ContentSyncReport {
  return {
    state: 'unknown',
    contentBranch: CONTENTRAIN_BRANCH,
    baseBranch,
    contentSha,
    baseSha,
    fastForward: false,
    checkedAt: new Date().toISOString(),
  }
}

/** Compute the reading — no cache, for callers that have just changed the answer. */
export async function checkContentSync(git: GitProvider): Promise<ContentSyncReport> {
  const baseBranch = await git.getDefaultBranch().catch(() => 'main')

  let tips: { contentSha: string | null, baseSha: string | null }
  try {
    const branches = await git.listBranches()
    tips = {
      contentSha: branches.find(b => b.name === CONTENTRAIN_BRANCH)?.sha ?? null,
      baseSha: branches.find(b => b.name === baseBranch)?.sha ?? null,
    }
  }
  catch {
    return unknown(baseBranch, null, null)
  }
  const { contentSha, baseSha } = tips

  // A project whose content branch has not been created yet is not out of
  // sync — it has no content branch. Saying `unknown` keeps that distinct from
  // "the branches agree".
  if (!contentSha || !baseSha) return unknown(baseBranch, contentSha, baseSha)

  const base = {
    contentBranch: CONTENTRAIN_BRANCH,
    baseBranch,
    contentSha,
    baseSha,
    checkedAt: new Date().toISOString(),
  }

  if (contentSha === baseSha) return { ...base, state: 'in_sync', fastForward: false }

  // Optional capability (types 1.2.0): a provider that cannot answer leaves the
  // state unknown rather than having Studio invent one from the tips alone.
  if (!git.getMergeBase) return unknown(baseBranch, contentSha, baseSha)

  const mergeBase = await git.getMergeBase(CONTENTRAIN_BRANCH, baseBranch).catch(() => null)
  if (!mergeBase) return unknown(baseBranch, contentSha, baseSha)

  if (mergeBase === baseSha) return { ...base, state: 'content_ahead', fastForward: false }
  if (mergeBase === contentSha) return { ...base, state: 'base_ahead', fastForward: true }
  return { ...base, state: 'diverged', fastForward: false }
}

/** The reading, cached. */
export async function readContentSync(git: GitProvider, projectId: string): Promise<ContentSyncReport> {
  const cached = await readCache(projectId)
  if (cached) return cached
  const report = await checkContentSync(git)
  await writeCache(projectId, report)
  return report
}
