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
): Promise<{ projectId: string, keyId: string }> {
  if (!authHeader?.startsWith('Bearer crn_'))
    throw createError({ statusCode: 401, message: 'Invalid or missing API key' })

  const key = authHeader.slice(7) // Remove "Bearer "
  const keyHash = hashCDNKey(key)

  const admin = useSupabaseAdmin()
  const { data: apiKey } = await admin
    .from('cdn_api_keys')
    .select('id, project_id, rate_limit_per_hour, revoked_at, expires_at')
    .eq('key_hash', keyHash)
    .is('revoked_at', null)
    .single()

  if (!apiKey)
    throw createError({ statusCode: 401, message: 'Invalid API key' })

  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date())
    throw createError({ statusCode: 401, message: 'API key expired' })

  // Update last_used_at (non-blocking, fire-and-forget with error logging)
  admin
    .from('cdn_api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', apiKey.id)
    .then(({ error }) => {
      // eslint-disable-next-line no-console
      if (error) console.warn('[cdn-keys] last_used_at update failed:', error.message)
    })

  return { projectId: apiKey.project_id, keyId: apiKey.id }
}
