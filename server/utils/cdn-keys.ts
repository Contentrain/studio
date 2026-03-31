/**
 * CDN API key generation, hashing, and validation.
 *
 * Key format: crn_live_{32-byte-base62} (~50 chars)
 * Storage: SHA-256 hash in DB (plaintext never stored)
 * Display: key_prefix (first 16 chars) for identification
 */

import { createHash, randomBytes } from 'node:crypto'

const KEY_PREFIX = 'crn_live_'
const RANDOM_BYTES = 32
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function toBase62(buffer: Buffer): string {
  let result = ''
  for (const byte of buffer) {
    result += BASE62_CHARS[byte % 62]
  }
  return result
}

/** Generate a new CDN API key. Returns { key, keyHash, keyPrefix }. */
export function generateCDNKey(): { key: string, keyHash: string, keyPrefix: string } {
  const random = toBase62(randomBytes(RANDOM_BYTES))
  const key = `${KEY_PREFIX}${random}`
  const keyHash = hashCDNKey(key)
  const keyPrefix = key.substring(0, 16)

  return { key, keyHash, keyPrefix }
}

/** SHA-256 hash a CDN API key. */
export function hashCDNKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** Validate a CDN API key against the database. Returns project info or throws. */
export async function validateCDNKey(
  authHeader: string | undefined,
): Promise<{ projectId: string, keyId: string, rateLimitPerHour: number, allowedOrigins: string[] }> {
  if (!authHeader?.startsWith('Bearer crn_'))
    throw createError({ statusCode: 401, message: errorMessage('cdn.key_invalid') })

  const key = authHeader.slice(7)
  const keyHash = hashCDNKey(key)
  const db = useDatabaseProvider()

  const apiKey = await db.validateCDNKeyHash(keyHash)
  if (!apiKey)
    throw createError({ statusCode: 401, message: errorMessage('cdn.key_invalid') })

  if (apiKey.expires_at && new Date(apiKey.expires_at as string) < new Date())
    throw createError({ statusCode: 401, message: errorMessage('cdn.key_expired') })

  // Update last_used_at (non-blocking)
  db.updateCDNKeyLastUsed(apiKey.id as string).catch(() => {})

  return {
    projectId: apiKey.project_id as string,
    keyId: apiKey.id as string,
    rateLimitPerHour: (apiKey.rate_limit_per_hour as number) ?? 1000,
    allowedOrigins: (apiKey.allowed_origins as string[]) ?? [],
  }
}
