/**
 * In-process TTL caches for the CDN delivery hot path.
 *
 * Every delivery request used to pay three sequential Supabase round-trips
 * (key validation, project flags, workspace plan) before touching R2. These
 * values change rarely, so they are memoized per instance for a short TTL.
 * Only the DB *inputs* are cached — every gate (key↔project match, CORS,
 * rate limiting, cdn_enabled, plan feature, metering) still runs on every
 * request.
 *
 * Invalidation model:
 * - TTL (60s) bounds all staleness, including across instances.
 * - Same-instance busts apply immediately: key revoke (bustCDNKeyCache)
 *   and CDN settings changes (bustProjectDeliveryCache).
 * - Positive results only: an invalid key or missing project is never
 *   cached, so error behavior is identical to the uncached path.
 *
 * Precedent: the accept-invite middleware keeps a process-local cache of
 * verified memberships (server/middleware/02.accept-invite.ts).
 */

import type { DatabaseRow } from '../providers/database'

interface CacheEntry<T> {
  value: T
  cachedAt: number
}

const TTL_MS = 60_000
const MAX_ENTRIES = 10_000
const SWEEP_INTERVAL_MS = 5 * 60_000

const keyCache = new Map<string, CacheEntry<CachedCDNKey>>()
const keyIdToHash = new Map<string, string>()
const projectCache = new Map<string, CacheEntry<DatabaseRow>>()
const workspacePlanCache = new Map<string, CacheEntry<DatabaseRow>>()

let lastSweep = Date.now()

function sweepIfDue(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return
  lastSweep = now
  for (const map of [keyCache, projectCache, workspacePlanCache]) {
    for (const [key, entry] of map) {
      if (now - entry.cachedAt > TTL_MS) map.delete(key)
    }
  }
  // Prune reverse-index entries whose key entry is gone (revoked/expired).
  const liveHashes = new Set(keyCache.keys())
  for (const [keyId, hash] of keyIdToHash) {
    if (!liveHashes.has(hash)) keyIdToHash.delete(keyId)
  }
}

function getFresh<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = map.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.cachedAt > TTL_MS) {
    map.delete(key)
    return undefined
  }
  return entry.value
}

function setEntry<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  // Hard cap as a runaway guard — a legitimate deployment holds far fewer
  // keys/projects/workspaces than this.
  if (map.size >= MAX_ENTRIES) map.clear()
  const now = Date.now()
  map.set(key, { value, cachedAt: now })
  sweepIfDue(now)
}

export interface CachedCDNKey {
  projectId: string
  keyId: string
  rateLimitPerHour: number
  allowedOrigins: string[]
  scopes: string[]
  expiresAt: string | null
}

/**
 * Cached counterpart of `validateCDNKey` (server/utils/cdn-keys.ts) for the
 * delivery hot path. Same error semantics (401 cdn.key_invalid /
 * cdn.key_expired); `expires_at` is re-checked on every hit so a key cannot
 * outlive its expiry through the cache. `last_used_at` is updated once per
 * cache fill (≈ once per TTL window) instead of once per request.
 */
export async function cachedValidateCDNKey(authHeader: string | undefined): Promise<CachedCDNKey> {
  if (!authHeader?.startsWith('Bearer crn_'))
    throw createError({ statusCode: 401, message: errorMessage('cdn.key_invalid') })

  const keyHash = hashCDNKey(authHeader.slice(7))

  const hit = getFresh(keyCache, keyHash)
  if (hit) {
    if (hit.expiresAt && new Date(hit.expiresAt) < new Date()) {
      keyCache.delete(keyHash)
      keyIdToHash.delete(hit.keyId)
      throw createError({ statusCode: 401, message: errorMessage('cdn.key_expired') })
    }
    return hit
  }

  const db = useDatabaseProvider()
  const apiKey = await db.validateCDNKeyHash(keyHash)
  if (!apiKey)
    throw createError({ statusCode: 401, message: errorMessage('cdn.key_invalid') })

  if (apiKey.expires_at && new Date(apiKey.expires_at as string) < new Date())
    throw createError({ statusCode: 401, message: errorMessage('cdn.key_expired') })

  const claims: CachedCDNKey = {
    projectId: apiKey.project_id as string,
    keyId: apiKey.id as string,
    rateLimitPerHour: (apiKey.rate_limit_per_hour as number) ?? 1000,
    allowedOrigins: (apiKey.allowed_origins as string[]) ?? [],
    scopes: (apiKey.scopes as string[]) ?? ['delivery'],
    expiresAt: (apiKey.expires_at as string | null) ?? null,
  }

  setEntry(keyCache, keyHash, claims)
  keyIdToHash.set(claims.keyId, keyHash)

  // Throttled by the cache: at most one write per key per TTL window.
  db.updateCDNKeyLastUsed(claims.keyId).catch(() => {})

  return claims
}

/** Project delivery flags (workspace_id, cdn_enabled, cdn_public_media), cached. */
export async function cachedProjectDelivery(projectId: string): Promise<DatabaseRow | null> {
  const hit = getFresh(projectCache, projectId)
  if (hit) return hit

  const db = useDatabaseProvider()
  const project = await db.getProjectById(projectId, 'workspace_id, cdn_enabled, cdn_public_media')
  if (project) setEntry(projectCache, projectId, project)
  return project
}

/** Workspace plan row, cached. Plan changes propagate within the TTL. */
export async function cachedWorkspacePlan(workspaceId: string): Promise<DatabaseRow | null> {
  const hit = getFresh(workspacePlanCache, workspaceId)
  if (hit) return hit

  const db = useDatabaseProvider()
  const workspace = await db.getWorkspaceById(workspaceId, 'plan')
  if (workspace) setEntry(workspacePlanCache, workspaceId, workspace)
  return workspace
}

/** Drop a key from the cache immediately (called on revoke). */
export function bustCDNKeyCache(keyId: string): void {
  const hash = keyIdToHash.get(keyId)
  if (hash) keyCache.delete(hash)
  keyIdToHash.delete(keyId)
}

/** Drop a project's delivery flags immediately (called on settings change). */
export function bustProjectDeliveryCache(projectId: string): void {
  projectCache.delete(projectId)
}

/** Test helper — reset all delivery caches. */
export function clearCDNDeliveryCaches(): void {
  keyCache.clear()
  keyIdToHash.clear()
  projectCache.clear()
  workspacePlanCache.clear()
}
