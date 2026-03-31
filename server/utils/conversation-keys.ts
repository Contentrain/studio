/**
 * Conversation API key generation, hashing, and validation.
 *
 * Key format: crn_conv_{32-byte-base62} (~50 chars)
 * Storage: SHA-256 hash in DB (plaintext never stored)
 * Display: key_prefix (first 16 chars) for identification
 */

import { createHash, randomBytes } from 'node:crypto'

const KEY_PREFIX = 'crn_conv_'
const RANDOM_BYTES = 32
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function toBase62(buffer: Buffer): string {
  let result = ''
  for (const byte of buffer) {
    result += BASE62_CHARS[byte % 62]
  }
  return result
}

/** Generate a new Conversation API key. Returns { key, keyHash, keyPrefix }. */
export function generateConversationKey(): { key: string, keyHash: string, keyPrefix: string } {
  const random = toBase62(randomBytes(RANDOM_BYTES))
  const key = `${KEY_PREFIX}${random}`
  const keyHash = hashConversationKey(key)
  const keyPrefix = key.substring(0, 16)

  return { key, keyHash, keyPrefix }
}

/** SHA-256 hash a Conversation API key. */
export function hashConversationKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** Conversation API key row from database */
export interface ConversationKeyData {
  keyId: string
  projectId: string
  workspaceId: string
  name: string
  role: 'viewer' | 'editor' | 'admin'
  specificModels: boolean
  allowedModels: string[]
  allowedTools: string[]
  allowedLocales: string[]
  customInstructions: string | null
  aiModel: string
  rateLimitPerMinute: number
  monthlyMessageLimit: number
}

/** Validate a Conversation API key. Returns key config or throws 401. */
export async function validateConversationKey(
  authHeader: string | undefined,
): Promise<ConversationKeyData> {
  if (!authHeader?.startsWith('Bearer crn_conv_'))
    throw createError({ statusCode: 401, message: errorMessage('conversation.key_invalid') })

  const key = authHeader.slice(7)
  const keyHash = hashConversationKey(key)
  const db = useDatabaseProvider()

  const apiKey = await db.validateConversationKeyHash(keyHash)
  if (!apiKey)
    throw createError({ statusCode: 401, message: errorMessage('conversation.key_invalid') })

  // Update last_used_at (non-blocking)
  db.updateConversationKeyLastUsed(apiKey.id as string).catch(() => {})

  return {
    keyId: apiKey.id as string,
    projectId: apiKey.project_id as string,
    workspaceId: apiKey.workspace_id as string,
    name: apiKey.name as string,
    role: apiKey.role as ConversationKeyData['role'],
    specificModels: (apiKey.specific_models as boolean) ?? false,
    allowedModels: (apiKey.allowed_models as string[]) ?? [],
    allowedTools: (apiKey.allowed_tools as string[]) ?? [],
    allowedLocales: (apiKey.allowed_locales as string[]) ?? [],
    customInstructions: (apiKey.custom_instructions as string) ?? null,
    aiModel: (apiKey.ai_model as string) ?? 'claude-sonnet-4-5',
    rateLimitPerMinute: (apiKey.rate_limit_per_minute as number) ?? 10,
    monthlyMessageLimit: (apiKey.monthly_message_limit as number) ?? 1000,
  }
}
