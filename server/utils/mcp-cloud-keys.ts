/**
 * MCP Cloud API key generation, hashing, and validation.
 *
 * Key format: crn_mcp_{32-byte-base62} (~50 chars)
 * Storage: SHA-256 hash in DB (plaintext never stored)
 * Display: key_prefix (first 16 chars) for identification
 *
 * Parallel to conversation-keys.ts — see handoff Rev 3 for the
 * "separate tables" decision rationale (`mcp_cloud_keys` and
 * `conversation_api_keys` don't share a schema because AI-specific
 * fields don't apply to raw tool access and the usage meters are
 * independent).
 */

import { createHash, randomBytes } from 'node:crypto'
import { useDatabaseProvider } from './providers'

const KEY_PREFIX = 'crn_mcp_'
const KEY_PREFIX_DISPLAY_LEN = 16
const RANDOM_BYTES = 32
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function toBase62(buffer: Buffer): string {
  let result = ''
  for (const byte of buffer) {
    result += BASE62_CHARS[byte % 62]
  }
  return result
}

/** Generate a new MCP Cloud API key. Returns `{ key, keyHash, keyPrefix }`. */
export function generateMcpCloudKey(): { key: string, keyHash: string, keyPrefix: string } {
  const random = toBase62(randomBytes(RANDOM_BYTES))
  const key = `${KEY_PREFIX}${random}`
  const keyHash = hashMcpCloudKey(key)
  const keyPrefix = key.substring(0, KEY_PREFIX_DISPLAY_LEN)

  return { key, keyHash, keyPrefix }
}

/** SHA-256 hash an MCP Cloud API key. */
export function hashMcpCloudKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** MCP Cloud key row after authentication. */
export interface McpCloudKeyData {
  keyId: string
  projectId: string
  workspaceId: string
  name: string
  allowedTools: string[]
  rateLimitPerMinute: number
  monthlyCallLimit: number | null
}

/**
 * Extract + validate an MCP Cloud API key from the `Authorization` header.
 * Returns the key configuration on success; throws a 401 error otherwise.
 * The plaintext key never reaches application logic beyond this function.
 */
export async function validateMcpCloudKey(authHeader: string | undefined): Promise<McpCloudKeyData> {
  if (typeof authHeader !== 'string' || !authHeader.startsWith(`Bearer ${KEY_PREFIX}`)) {
    throw createError({ statusCode: 401, message: errorMessage('mcp_cloud.key_invalid') })
  }

  const key = authHeader.slice('Bearer '.length).trim()
  const keyHash = hashMcpCloudKey(key)

  const db = useDatabaseProvider()
  const row = await db.getMcpCloudKeyByHash(keyHash)

  if (!row || row.revoked_at) {
    throw createError({ statusCode: 401, message: errorMessage('mcp_cloud.key_invalid') })
  }

  const keyId = row.id as string

  // Best-effort last_used_at bump — don't block the request path on it.
  db.touchMcpCloudKey(keyId).catch(() => { /* swallow */ })

  return {
    keyId,
    projectId: row.project_id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    allowedTools: (row.allowed_tools as string[] | null) ?? [],
    rateLimitPerMinute: (row.rate_limit_per_minute as number | null) ?? 60,
    monthlyCallLimit: (row.monthly_call_limit as number | null) ?? null,
  }
}
