/**
 * Conversation API key generation, hashing, and validation.
 *
 * Key format: crn_conv_{32-byte-base62} (~50 chars)
 * Storage: SHA-256 hash in DB (plaintext never stored)
 * Display: key_prefix (first 16 chars) for identification
 *
 * Follows identical pattern as CDN keys (cdn-keys.ts).
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

  const key = authHeader.slice(7) // Remove "Bearer "
  const keyHash = hashConversationKey(key)

  const admin = useSupabaseAdmin()
  const { data: apiKey } = await admin
    .from('conversation_api_keys')
    .select('id, project_id, workspace_id, name, role, specific_models, allowed_models, allowed_tools, allowed_locales, custom_instructions, ai_model, rate_limit_per_minute, monthly_message_limit, revoked_at')
    .eq('key_hash', keyHash)
    .is('revoked_at', null)
    .single()

  if (!apiKey)
    throw createError({ statusCode: 401, message: errorMessage('conversation.key_invalid') })

  // Update last_used_at (non-blocking)
  admin
    .from('conversation_api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', apiKey.id)
    .then(({ error }) => {
      // eslint-disable-next-line no-console
      if (error) console.warn('[conversation-keys] last_used_at update failed:', error.message)
    })

  return {
    keyId: apiKey.id,
    projectId: apiKey.project_id,
    workspaceId: apiKey.workspace_id,
    name: apiKey.name,
    role: apiKey.role as ConversationKeyData['role'],
    specificModels: apiKey.specific_models ?? false,
    allowedModels: (apiKey.allowed_models as string[] | null) ?? [],
    allowedTools: (apiKey.allowed_tools as string[] | null) ?? [],
    allowedLocales: (apiKey.allowed_locales as string[] | null) ?? [],
    customInstructions: apiKey.custom_instructions ?? null,
    aiModel: apiKey.ai_model ?? 'claude-sonnet-4-5',
    rateLimitPerMinute: apiKey.rate_limit_per_minute ?? 10,
    monthlyMessageLimit: apiKey.monthly_message_limit ?? 1000,
  }
}
