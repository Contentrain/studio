/**
 * Branch health — monitors cr/* branch count and cleans up merged branches.
 *
 * Per git-architecture.md §8.2:
 * - 0–49 unmerged cr/*: OK — operations proceed
 * - 50–79 unmerged cr/*: WARNING — operations proceed, user alerted
 * - 80+  unmerged cr/*: BLOCKED — new write operations rejected
 *
 * Merged branches are auto-deleted after branchRetention days (default 30).
 *
 * Cache: Redis when available (multi-instance safe), in-memory Map fallback.
 */
import type { GitProvider } from '../providers/git'
import { getRedis } from './redis'

// ── Types ────────────────────────────────────────────

export type BranchHealthStatus = 'ok' | 'warning' | 'blocked'

export interface BranchHealthReport {
  status: BranchHealthStatus
  unmergedCount: number
  lastChecked: string
}

export interface CleanupReport {
  deleted: string[]
  remaining: number
  status: BranchHealthStatus
}

// ── Constants ────────────────────────────────────────

const WARNING_THRESHOLD = 50
const BLOCKED_THRESHOLD = 80
const DEFAULT_RETENTION_DAYS = 30
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours
const CACHE_TTL_SECONDS = Math.ceil(CACHE_TTL_MS / 1000)
const REDIS_PREFIX = 'brh:'

// ── In-memory fallback cache ─────────────────────────

const memoryCache = new Map<string, BranchHealthReport>()

// ── Cache operations (Redis → in-memory fallback) ────

export async function getHealthStatus(projectId: string): Promise<BranchHealthReport | undefined> {
  const r = getRedis()
  if (r) {
    try {
      const raw = await r.get(`${REDIS_PREFIX}${projectId}`)
      if (!raw) return undefined
      return JSON.parse(raw) as BranchHealthReport
    }
    catch {
      // Redis read failed — fall through to memory
    }
  }

  const cached = memoryCache.get(projectId)
  if (!cached) return undefined

  const age = Date.now() - new Date(cached.lastChecked).getTime()
  if (age > CACHE_TTL_MS) {
    memoryCache.delete(projectId)
    return undefined
  }
  return cached
}

export async function setHealthStatus(projectId: string, report: BranchHealthReport): Promise<void> {
  // Always write to memory (fast local reads when Redis is slow)
  memoryCache.set(projectId, report)

  const r = getRedis()
  if (r) {
    try {
      await r.set(`${REDIS_PREFIX}${projectId}`, JSON.stringify(report), 'EX', CACHE_TTL_SECONDS)
    }
    catch {
      // Redis write failed — in-memory is still valid
    }
  }
}

export async function clearHealthCache(): Promise<void> {
  memoryCache.clear()

  const r = getRedis()
  if (r) {
    try {
      // Scan + delete all brh:* keys
      let cursor = '0'
      do {
        const [nextCursor, keys] = await r.scan(cursor, 'MATCH', `${REDIS_PREFIX}*`, 'COUNT', 100)
        cursor = nextCursor
        if (keys.length > 0) {
          await r.del(...keys)
        }
      } while (cursor !== '0')
    }
    catch {
      // Redis clear failed — in-memory already cleared
    }
  }
}

// ── Status calculation ───────────────────────────────

export function calculateStatus(unmergedCount: number): BranchHealthStatus {
  if (unmergedCount >= BLOCKED_THRESHOLD) return 'blocked'
  if (unmergedCount >= WARNING_THRESHOLD) return 'warning'
  return 'ok'
}

// ── Health check (reads branch list + checks merge status) ───

export async function checkBranchHealth(
  git: GitProvider,
  projectId: string,
): Promise<BranchHealthReport> {
  const branches = await git.listBranches('cr/')
  let unmergedCount = 0

  for (const branch of branches) {
    const merged = await git.isMerged(branch.name)
    if (!merged) unmergedCount++
  }

  const report: BranchHealthReport = {
    status: calculateStatus(unmergedCount),
    unmergedCount,
    lastChecked: new Date().toISOString(),
  }
  await setHealthStatus(projectId, report)
  return report
}

// ── Cleanup (deletes merged cr/* branches past retention) ────

export async function cleanupMergedBranches(
  git: GitProvider,
  projectId: string,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<CleanupReport> {
  const branches = await git.listBranches('cr/')
  const deleted: string[] = []
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

  for (const branch of branches) {
    const merged = await git.isMerged(branch.name)
    if (!merged) continue

    // Extract timestamp from branch name: cr/{scope}/{target}/[{locale}/]{timestamp}-{suffix}
    const branchTimestamp = extractBranchTimestamp(branch.name)
    if (branchTimestamp !== null && branchTimestamp * 1000 > cutoff) continue

    try {
      await git.deleteBranch(branch.name)
      deleted.push(branch.name)
    }
    catch {
      // Best-effort: branch may have been deleted by another process
    }
  }

  const remaining = branches.length - deleted.length
  const report: CleanupReport = {
    deleted,
    remaining,
    status: calculateStatus(remaining),
  }

  // Update cache after cleanup
  await setHealthStatus(projectId, {
    status: report.status,
    unmergedCount: remaining,
    lastChecked: new Date().toISOString(),
  })

  return report
}

/**
 * Extract the Unix timestamp from a cr/* branch name.
 * Format: cr/{scope}/{target}[/{locale}]/{timestamp}-{suffix}
 * Returns null if timestamp cannot be extracted.
 */
export function extractBranchTimestamp(branchName: string): number | null {
  const parts = branchName.split('/')
  const lastPart = parts[parts.length - 1]
  if (!lastPart) return null

  const match = lastPart.match(/^(\d+)-/)
  if (!match) return null

  const ts = Number(match[1])
  return Number.isFinite(ts) ? ts : null
}

// ── Expose thresholds for testing ────────────────────

export const THRESHOLDS = {
  WARNING: WARNING_THRESHOLD,
  BLOCKED: BLOCKED_THRESHOLD,
  DEFAULT_RETENTION_DAYS,
  CACHE_TTL_MS,
} as const
